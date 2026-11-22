import { ConvexError } from "convex/values";
import { z } from "zod";
import type { evidenceFields, signalKind } from "../../shared/contract";

type EvidenceFields = { [Field in keyof typeof evidenceFields]: (typeof evidenceFields)[Field]["type"] };
export type MarketSignal = {
  key: string;
  domain: string;
  date: string;
  kind: typeof signalKind.type;
  label: string;
  excerpt: string;
  url: string | null;
  count?: number;
  round?: string;
  amountUsd?: number;
};

const text = z.string().nullish();
const number = z.number().nullish();
const id = z.union([z.string(), z.number()]);
const employment = z.object({ title: text, name: text, description: text, start_date: text, end_date: text, company_website: text, position_id: id.nullish() });
const history = z.object({ current: z.array(employment).nullish(), past: z.array(employment).nullish() });
const personData = z.object({ experience: z.object({ employment_details: history.nullish() }).nullish() });
const companyBasic = z.object({ name: text, primary_domain: text, website: text });
const dayMs = 86_400_000;
const skillTitle = /inferenc|\bml\b|machine learning|gpu|serving|model platform/i;

export const crustdataEndpoints = ["/person/enrich", "/job/search", "/company/enrich", "/person/search"] as const;
type Endpoint = (typeof crustdataEndpoints)[number];

async function crustdata<T>(endpoint: Endpoint, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const key = process.env.CRUSTDATA_API_KEY;
  if (!key) throw new ConvexError("Crustdata is not configured.");
  const response = await fetch(`https://api.crustdata.com${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-api-version": "2025-11-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new ConvexError(`Crustdata ${endpoint} returned HTTP ${response.status}.`);
  const output = schema.safeParse(await response.json());
  if (!output.success) throw new ConvexError(`Crustdata ${endpoint} returned an unexpected response.`);
  return output.data;
}

function dateOnly(input: string | undefined | null) {
  const date = input?.slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) return null;
  return new Date(date).toISOString().slice(0, 10) === date ? date : null;
}

function cleanExcerpt(input: string) {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000);
}

export function domainOf(input: string | null | undefined) {
  if (!input) return null;
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/.test(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

function httpsUrl(input: string | null | undefined) {
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export async function enrichLinkedIn(linkedInUrl: string, retrievedAt: string): Promise<EvidenceFields[]> {
  const envelope = z.array(z.object({
    match_status: z.string(),
    matches: z.array(z.object({ person_data: personData })),
  }));
  const rows = await crustdata("/person/enrich", {
    professional_network_profile_urls: [linkedInUrl],
    fields: [
      "experience.employment_details.current.title", "experience.employment_details.current.name",
      "experience.employment_details.current.description", "experience.employment_details.current.start_date",
      "experience.employment_details.past.title", "experience.employment_details.past.name",
      "experience.employment_details.past.description", "experience.employment_details.past.start_date",
    ],
  }, envelope);
  const row = rows[0];
  if (row?.match_status !== "matched" || row.matches.length !== 1) return [];
  const roles = row.matches[0].person_data.experience?.employment_details;
  return [...(roles?.current ?? []), ...(roles?.past ?? [])].slice(0, 8).flatMap((role) => {
    const title = [role.title, role.name].filter(Boolean).join(" at ");
    if (!title) return [];
    return [{
      title,
      excerpt: cleanExcerpt([title, role.description].filter(Boolean).join(". ")),
      url: linkedInUrl,
      eventDate: dateOnly(role.start_date),
      retrievedAt,
      source: "Crustdata Person Enrich",
      mode: "live",
    }];
  });
}

const leaf = (field: string, type: string, value: unknown) => ({ field, type, value });
const and = (...conditions: ReturnType<typeof leaf>[]) => ({ op: "and", conditions });

const jobResponse = z.object({
  job_listings: z.array(z.object({
    crustdata_job_id: id.nullish(),
    job_details: z.object({ job_id: id.nullish(), title: text, url: text }).nullish(),
    company: z.object({ basic_info: companyBasic.nullish() }).nullish(),
    metadata: z.object({ date_added: text }).nullish(),
    content: z.object({ description: text }).nullish(),
  })),
  next_cursor: z.string().nullish(),
});

export async function searchCompanyJobs(domains: string[], from: string, through: string) {
  const end = new Date(Date.parse(through) + dayMs).toISOString().slice(0, 10);
  const rows = await crustdata("/job/search", {
    filters: and(
      leaf("company.basic_info.primary_domain", "in", domains),
      leaf("metadata.date_added", "=>", from),
      leaf("metadata.date_added", "<", end),
    ),
    fields: ["job_details", "company.basic_info", "metadata.date_added", "content.description"],
    limit: 80,
  }, jobResponse);
  const signals: MarketSignal[] = rows.job_listings.flatMap((row) => {
    const domain = domainOf(row.company?.basic_info?.primary_domain ?? row.company?.basic_info?.website);
    const date = dateOnly(row.metadata?.date_added);
    const label = row.job_details?.title;
    const sourceId = row.crustdata_job_id ?? row.job_details?.job_id;
    if (!domain || !domains.includes(domain) || !date || date < from || date > through || !label || sourceId == null) return [];
    return [{
      key: `crustdata:job:${domain}:${sourceId}`, domain, date, kind: "job_post", label,
      excerpt: cleanExcerpt(row.content?.description || label),
      url: httpsUrl(row.job_details?.url),
    }];
  });
  return { signals, partial: Boolean(rows.next_cursor || rows.job_listings.length >= 80 || signals.length < rows.job_listings.length) };
}

const companyResponse = z.array(z.object({
  matches: z.array(z.object({
    company_data: z.object({
      basic_info: companyBasic.nullish(),
      headcount: z.object({ timeseries: z.array(z.object({ date: text, employee_count: number })).nullish() }).nullish(),
      funding: z.object({ last_fundraise_date: text, last_round_type: text, last_round_amount_usd: number }).nullish(),
    }),
  })),
}));

export async function enrichCompanies(domains: string[], from: string, through: string) {
  const rows = await crustdata("/company/enrich", {
    domains, exact_match: true, fields: ["basic_info", "headcount", "funding"],
  }, companyResponse);
  return rows.flatMap((row) => {
    const data = row.matches[0]?.company_data;
    const domain = domainOf(data?.basic_info?.primary_domain ?? data?.basic_info?.website);
    const name = data?.basic_info?.name;
    if (!domain || !domains.includes(domain) || !name) return [];
    const homepage = `https://${domain}`;
    const headcount = (data.headcount?.timeseries ?? []).flatMap((point) => {
      const date = dateOnly(point.date);
      if (!date || date > through || point.employee_count == null) return [];
      return [{ date, count: point.employee_count }];
    }).sort((left, right) => left.date.localeCompare(right.date));
    const baseline = headcount.filter((point) => point.date < from).at(-1);
    const signals: MarketSignal[] = [...(baseline ? [baseline] : []), ...headcount.filter((point) => point.date >= from)].map((point) => ({
      key: `crustdata:headcount:${domain}:${point.date}`, domain, kind: "headcount",
      date: point.date, label: `${name} headcount`, excerpt: `Crustdata reported ${point.count} employees on ${point.date}.`,
      count: point.count, url: null,
    }));
    const fundingDate = dateOnly(data.funding?.last_fundraise_date);
    if (fundingDate && fundingDate <= through) {
      const round = data.funding?.last_round_type || "Undisclosed";
      signals.push({
        key: `crustdata:funding:${domain}:${fundingDate}`, domain, kind: "funding",
        date: fundingDate, label: `${name} ${round} funding`, excerpt: `Crustdata recorded a ${round} round on ${fundingDate}.`,
        round, ...(data.funding?.last_round_amount_usd == null ? {} : { amountUsd: data.funding.last_round_amount_usd }), url: null,
      });
    }
    return [{ domain, name, homepage, signals }];
  });
}

const moveResponse = z.object({
  profiles: z.array(personData.extend({ crustdata_person_id: id })),
  next_cursor: z.string().nullish(),
});

export async function searchTalentMoves(domains: string[], from: string, through: string) {
  const end = new Date(Date.parse(through) + dayMs).toISOString().slice(0, 10);
  const root = "experience.employment_details.current";
  const prior = "experience.employment_details.past";
  const inWindow = (field: string) => and(leaf(field, "=>", from), leaf(field, "<", end));
  const rows = await crustdata("/person/search", {
    filters: {
      op: "or", conditions: [
        { op: "and", conditions: [leaf(`${root}.company_website_domain`, "in", domains), ...inWindow(`${root}.start_date`).conditions] },
        { op: "and", conditions: [leaf(`${prior}.company_website_domain`, "in", domains), ...inWindow(`${root}.start_date`).conditions] },
      ],
    },
    fields: [root, prior].flatMap((prefix) => ["title", "start_date", "end_date", "company_website"].map((field) => `${prefix}.${field}`)),
    limit: 80,
  }, moveResponse);
  const groups = new Map<string, { domain: string; date: string; kind: "hire" | "departure"; people: Set<string> }>();
  function add(kind: "hire" | "departure", domain: string | null, date: string | null, personId: string) {
    if (!domain || !domains.includes(domain) || !date || date < from || date > through) return;
    const key = `crustdata:${kind}:${domain}:${date}`;
    const group = groups.get(key) ?? { kind, domain, date, people: new Set<string>() };
    group.people.add(personId);
    groups.set(key, group);
  }
  for (const person of rows.profiles) {
    const roles = person.experience?.employment_details;
    const personId = String(person.crustdata_person_id);
    for (const role of roles?.current ?? []) {
      if (skillTitle.test(role.title ?? "")) add("hire", domainOf(role.company_website), dateOnly(role.start_date), personId);
    }
    const currentDomains = new Set((roles?.current ?? []).map((role) => domainOf(role.company_website)));
    for (const role of roles?.past ?? []) {
      const domain = domainOf(role.company_website);
      if (!currentDomains.has(domain) && skillTitle.test(role.title ?? "")) add("departure", domain, dateOnly(role.end_date), personId);
    }
  }
  const signals: MarketSignal[] = [...groups].map(([key, { domain, kind, date, people }]) => {
    const label = kind === "hire" ? "Observed technical hires" : "Observed technical departures";
    return { key, domain, kind, date, label, excerpt: `${people.size} in Crustdata's observed work histories.`, count: people.size, url: null };
  });
  return { signals, partial: true };
}
