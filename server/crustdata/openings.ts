// Crustdata reads for the openings pipeline (rule O1). Request shapes follow docs.crustdata.com person, job and company
// references; filters were verified live on 22 Nov 2026 (docs/LIVE-DATA.md).
import { z } from 'zod';
import type { Evidence, IsoDate } from '../../shared/types.ts';
import type { RoleFamily } from '../../shared/desk.ts';
import { shiftDays } from '../domain/facts.ts';
import { FAMILY_PHRASES, monthInterval, roleFamily } from '../domain/openings.ts';
import type { DepartureFact, ReplacementFact } from '../domain/openings.ts';
import type { ParseMeta } from '../domain/types.ts';
import { condition, evidenceRow, group, int, str, validate } from './common.ts';
import type { Filter } from './common.ts';
import type { EndpointSpec } from './spec.ts';

const ROLE = 'experience.employment_details.';
export const DEPARTURE_PAGE = 200;
export const DEPARTURE_PAGES = 10;
// The same phrase set as the live funnel pull, so a scan reproduces docs/LIVE-DATA.md exactly.
export const DEPARTURE_PHRASES = ['inference', 'serving', 'ML platform', 'ML infrastructure', 'MLOps', 'GPU', 'LLM infrastructure',
  'AI infrastructure', 'ML systems', 'machine learning platform', 'machine learning infrastructure', 'model deployment'];
const roleFields = ['name', 'title', 'start_date', 'end_date', 'crustdata_company_id', 'company_headcount_latest', 'company_website', 'company_industries'];

const role = z.object({
  name: str, title: str, start_date: str, end_date: str, crustdata_company_id: int, company_headcount_latest: int, company_website: str,
}).passthrough();
const peopleResponse = z.object({
  profiles: z.array(z.object({
    crustdata_person_id: int,
    basic_profile: z.object({ name: str }).passthrough().nullish(),
    experience: z.object({ employment_details: z.object({ current: z.array(role).nullish(), past: z.array(role).nullish() }).passthrough().nullish() }).passthrough().nullish(),
  }).passthrough()),
  next_cursor: str, total_count: int,
}).passthrough();

const monthName = (day: IsoDate) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const domainOf = (website?: string | null) => website ? website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() || null : null;
const initialOf = (name?: string | null) => (name?.trim()?.[0]?.toUpperCase() ?? '?') + '.';

export interface ScanWindow { asOf: IsoDate; runKind: 'live' | 'replay' }
export interface CohortCompany { id: string; crustdataId: number; name: string; headcount: number | null; domain: string | null }
export interface DeparturesPage { departures: DepartureFact[]; companies: CohortCompany[]; evidence: Evidence[]; nextCursor: string | null; totalCount: number | null }

/** Start-date bounds for the new role: live (asOf − 90, asOf]; replay (asOf − 120, asOf − 30] (30-day profile lag). */
export function departureBounds({ asOf, runKind }: ScanWindow): Filter[] {
  const start = ROLE + 'current.start_date';
  return runKind === 'replay'
    ? [condition(start, '>', shiftDays(asOf, -120)), condition(start, '=<', shiftDays(asOf, -30))]
    : [condition(start, '=>', shiftDays(asOf, -90))];
}

export const personDepartures: EndpointSpec<{ window: ScanWindow; cursor?: string }, DeparturesPage> = {
  name: 'person_departures', path: '/person/search', method: 'POST',
  build({ window, cursor }) {
    return {
      filters: group('and', [...departureBounds(window),
        group('or', DEPARTURE_PHRASES.map(phrase => condition(ROLE + 'past.title', '[.]', phrase)))]),
      limit: DEPARTURE_PAGE,
      // The name is requested only to keep an initial; no profile URL, email or phone is requested or stored.
      fields: ['crustdata_person_id', 'basic_profile.name', ...['current', 'past'].flatMap(kind => roleFields.map(field => `${ROLE}${kind}.${field}`))],
      ...(cursor ? { cursor } : {}),
    };
  },
  parse(raw, { window }, meta) {
    const body = validate(peopleResponse, raw);
    const departures: DepartureFact[] = [];
    const companies = new Map<string, CohortCompany>();
    const evidence: Evidence[] = [];
    for (const person of body.profiles) {
      const personId = String(person.crustdata_person_id ?? '');
      if (!personId) continue;
      const roles = person.experience?.employment_details;
      const current = (roles?.current ?? []).filter(row => row.start_date && row.name);
      for (const past of roles?.past ?? []) {
        const family = roleFamily(past.title);
        if (!family || !past.end_date || past.crustdata_company_id == null || !past.name) continue;
        const left = monthInterval(past.end_date);
        // A direct move: the new role starts no earlier than the month the old one ended, within 60 days.
        const next = current.filter(row => row.crustdata_company_id !== past.crustdata_company_id)
          .map(row => ({ row, started: monthInterval(row.start_date!) }))
          .filter(({ started }) => started[1] >= left[0] && (Date.parse(started[0]) - Date.parse(left[1])) / 86_400_000 <= 60)
          .sort((a, b) => a.started[0].localeCompare(b.started[0]))[0];
        if (!next) continue;
        const companyId = 'cd:' + past.crustdata_company_id;
        const initial = initialOf(person.basic_profile?.name);
        const recordId = `${personId}:${past.crustdata_company_id}:${past.end_date.slice(0, 7)}`;
        const observed = left[1] > window.asOf ? window.asOf : left[1];
        const row = evidenceRow(meta, recordId, '$.experience.employment_details.past[].end_date',
          `${initial} left a ${past.title} role at ${past.name} in ${monthName(left[0])} and started at ${next.row.name} in ` +
          `${monthName(next.started[0])} (month precision).`, observed, past.title!);
        evidence.push(row);
        departures.push({
          id: 'dp_' + recordId, personKey: personId, companyId, companyName: past.name, role: past.title!, roleFamily: family, initial,
          left, started: next.started, toCompanyId: next.row.crustdata_company_id != null ? 'cd:' + next.row.crustdata_company_id : null,
          toCompanyName: next.row.name ?? null, toDomain: domainOf(next.row.company_website), fromDomain: domainOf(past.company_website),
          evidenceId: row.id,
        });
        if (!companies.has(companyId)) companies.set(companyId, { id: companyId, crustdataId: past.crustdata_company_id, name: past.name,
          headcount: past.company_headcount_latest ?? null, domain: domainOf(past.company_website) });
      }
    }
    return { departures, companies: [...companies.values()], evidence, nextCursor: body.next_cursor ?? null, totalCount: body.total_count ?? null };
  },
  estimateCredits: raw => 0.23 * ((raw as { profiles?: unknown[] } | null)?.profiles?.length ?? DEPARTURE_PAGE),
};

export interface ReplacementCheck { companyId: string; crustdataId: number; roleFamily: RoleFamily; since: IsoDate }
export interface ReplacementBatch { replacements: ReplacementFact[]; evidence: Evidence[]; checked: string[] }
const familyTitle = (field: string, family: RoleFamily) => group('or', FAMILY_PHRASES[family].map(phrase => condition(field, '[.]', phrase)));
const through = (asOf: IsoDate) => shiftDays(asOf, 1);

const jobResponse = z.object({ job_listings: z.array(z.object({
  crustdata_job_id: int,
  job_details: z.object({ title: str, url: str }).passthrough().nullish(),
  company: z.object({ basic_info: z.object({ crustdata_company_id: int, name: str }).passthrough().nullish() }).passthrough().nullish(),
  metadata: z.object({ date_added: str }).passthrough().nullish(),
}).passthrough()), total_count: int }).passthrough();

/** One job search covering every candidate (company, family): a dated post since the last departure month is a replacement. */
export const jobReplacements: EndpointSpec<{ asOf: IsoDate; checks: ReplacementCheck[] }, ReplacementBatch> = {
  name: 'job_replacements', path: '/job/search', method: 'POST',
  build({ asOf, checks }) {
    return {
      filters: group('and', [condition('metadata.date_added', '<', through(asOf)), group('or', checks.map(check => group('and', [
        condition('company.basic_info.company_id', '=', check.crustdataId), condition('metadata.date_added', '=>', check.since),
        familyTitle('job_details.title', check.roleFamily)])))]),
      sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 200,
      fields: ['crustdata_job_id', 'job_details.title', 'job_details.url', 'company.basic_info.crustdata_company_id', 'company.basic_info.name', 'metadata.date_added'],
    };
  },
  parse(raw, { asOf, checks }, meta) {
    const body = validate(jobResponse, raw);
    const replacements: ReplacementFact[] = [];
    const evidence: Evidence[] = [];
    for (const job of body.job_listings) {
      const day = job.metadata?.date_added?.slice(0, 10);
      const title = job.job_details?.title;
      const crustdataId = job.company?.basic_info?.crustdata_company_id;
      if (!day || !title || crustdataId == null || day > asOf) continue;
      const family = roleFamily(title) ?? checks.find(check => check.crustdataId === crustdataId &&
        FAMILY_PHRASES[check.roleFamily].some(phrase => title.toLowerCase().includes(phrase.toLowerCase())))?.roleFamily;
      const check = checks.find(c => c.crustdataId === crustdataId && c.roleFamily === family && day >= c.since);
      if (!check) continue;
      const row = evidenceRow(meta, String(job.crustdata_job_id ?? `${crustdataId}:${title}:${day}`), '$.job_details.title',
        `${job.company?.basic_info?.name ?? 'The company'} posted “${title}” on ${day}.`, day, title, job.job_details?.url);
      evidence.push(row);
      replacements.push({ companyId: check.companyId, roleFamily: check.roleFamily, kind: 'job_post', date: [day, day],
        label: `posted “${title}” on ${day}`, evidenceId: row.id });
    }
    return { replacements, evidence, checked: [...new Set(checks.map(check => check.companyId))] };
  },
  estimateCredits: raw => 0.03 * ((raw as { job_listings?: unknown[] } | null)?.job_listings?.length ?? 20),
};

/** One person search: a hire into the family at A since the last departure month is a replacement. */
export const personReplacements: EndpointSpec<{ asOf: IsoDate; checks: ReplacementCheck[]; lagDays?: number }, ReplacementBatch> = {
  name: 'person_replacements', path: '/person/search', method: 'POST',
  build({ asOf, checks, lagDays }) {
    const current = ROLE + 'current.';
    const families = [...new Set(checks.map(check => check.roleFamily))];
    const since = checks.map(check => check.since).sort()[0] ?? asOf;
    return {
      filters: group('and', [
        condition(current + 'company_id', 'in', [...new Set(checks.map(check => check.crustdataId))]),
        condition(current + 'start_date', '=>', since), condition(current + 'start_date', '=<', shiftDays(asOf, -(lagDays ?? 0))),
        group('or', families.flatMap(family => FAMILY_PHRASES[family].map(phrase => condition(current + 'title', '[.]', phrase)))),
      ]),
      limit: 100,
      fields: ['crustdata_person_id', ...['title', 'start_date', 'crustdata_company_id', 'name'].map(field => current + field)],
    };
  },
  parse(raw, { checks }, meta) {
    const body = validate(peopleResponse, raw);
    const replacements: ReplacementFact[] = [];
    const evidence: Evidence[] = [];
    for (const person of body.profiles) {
      for (const row of person.experience?.employment_details?.current ?? []) {
        const family = roleFamily(row.title);
        const check = checks.find(c => c.crustdataId === row.crustdata_company_id && c.roleFamily === family);
        if (!check || !row.start_date) continue;
        const started = monthInterval(row.start_date);
        if (started[1] < check.since) continue;
        const ev = evidenceRow(meta, `${person.crustdata_person_id}:${row.crustdata_company_id}:${row.start_date.slice(0, 7)}`,
          '$.experience.employment_details.current[].start_date',
          `${row.name} hired a ${row.title} who started in ${monthName(started[0])} (month precision).`, started[0], row.title!);
        evidence.push(ev);
        replacements.push({ companyId: check.companyId, roleFamily: check.roleFamily, kind: 'hire', date: started,
          label: `hired a ${row.title} (${monthName(started[0])})`, evidenceId: ev.id });
      }
    }
    return { replacements, evidence, checked: [...new Set(checks.map(check => check.companyId))] };
  },
  estimateCredits: raw => 0.23 * ((raw as { profiles?: unknown[] } | null)?.profiles?.length ?? 10),
};

const enrichResponse = z.array(z.object({ matches: z.array(z.object({ company_data: z.object({
  crustdata_company_id: int,
  basic_info: z.object({ crustdata_company_id: int, name: str, primary_domain: str }).passthrough().nullish(),
  headcount: z.object({ total: int, timeseries: z.array(z.object({ date: str, employee_count: int }).passthrough()).nullish() }).passthrough().nullish(),
}).passthrough().nullish() }).passthrough()).nullish() }).passthrough());

export interface HeadcountFact { crustdataId: number; headcount: number | null; change90d: number | null; change30d?: number | null; evidenceId: string | null }

/** Company enrich for size (as of the cutoff) and the 90-day headcount change behind the restructure guard. */
export const companyHeadcount: EndpointSpec<{ asOf: IsoDate; crustdataIds: number[] }, { facts: HeadcountFact[]; evidence: Evidence[] }> = {
  name: 'company_headcount', path: '/company/enrich', method: 'POST',
  build: ({ crustdataIds }) => ({ crustdata_company_ids: [...new Set(crustdataIds)], fields: ['basic_info', 'headcount'] }),
  parse(raw, { asOf, crustdataIds }, meta: ParseMeta) {
    const facts: HeadcountFact[] = [];
    const evidence: Evidence[] = [];
    for (const result of validate(enrichResponse, raw)) {
      const company = result.matches?.[0]?.company_data;
      const id = company?.crustdata_company_id ?? company?.basic_info?.crustdata_company_id;
      if (!company || id == null || !crustdataIds.includes(id)) continue;
      const series = (company.headcount?.timeseries ?? []).filter(point => point.date && point.employee_count != null && point.date.slice(0, 10) <= asOf)
        .sort((a, b) => a.date!.localeCompare(b.date!));
      const last = series.at(-1);
      const earlier = last && series.filter(point => {
        const days = (Date.parse(last.date!) - Date.parse(point.date!)) / 86_400_000;
        return days >= 80 && days <= 100;
      }).at(-1);
      const change = last && earlier?.employee_count ? (last.employee_count! / earlier.employee_count - 1) * 100 : null;
      const month = last && series.filter(point => {
        const days = (Date.parse(last.date!) - Date.parse(point.date!)) / 86_400_000;
        return days >= 28 && days <= 35;
      }).at(-1);
      const change30d = last && month?.employee_count ? (last.employee_count! / month.employee_count - 1) * 100 : null;
      const headcount = last?.employee_count ?? (meta.mode === 'fixture' || asOf >= (meta.retrievedAt ?? '').slice(0, 10) ? company.headcount?.total ?? null : null);
      let evidenceId: string | null = null;
      if (last) {
        const name = company.basic_info?.name ?? 'The company';
        const row = evidenceRow(meta, String(id), '$.headcount.timeseries',
          `${name} had ${last.employee_count} employees on ${last.date!.slice(0, 10)}` +
          (change != null ? ` (${change >= 0 ? '+' : ''}${change.toFixed(1)}% since ${earlier!.date!.slice(0, 10)}).` : '.'),
          last.date!.slice(0, 10), last.employee_count!);
        evidence.push(row);
        evidenceId = row.id;
      }
      facts.push({ crustdataId: id, headcount, change90d: change, change30d, evidenceId });
    }
    return { facts, evidence };
  },
  estimateCredits: (_raw, { crustdataIds }) => 2 * crustdataIds.length,
};

export interface OutcomeRow { crustdataId: number; kind: 'job_post' | 'hire'; date: IsoDate; title: string; roleFamily: RoleFamily | null; evidenceId: string }
export interface OutcomeInput { crustdataIds: number[]; after: IsoDate; through: IsoDate; familyOnly: boolean; cursor?: string; label: string }
const allFamilyPhrases = [...new Set((['inference', 'ml_platform', 'mlops', 'gpu_llm_infra'] as RoleFamily[]).flatMap(family => FAMILY_PHRASES[family]))];

/** Replay outcome and baseline reads: dated job posts at the given companies in (after, through]. */
export const jobOutcomes: EndpointSpec<OutcomeInput, { rows: OutcomeRow[]; evidence: Evidence[]; nextCursor: string | null }> = {
  name: 'job_outcomes', path: '/job/search', method: 'POST',
  build: ({ crustdataIds, after, through: end, familyOnly, cursor }) => ({
    filters: group('and', [condition('company.basic_info.company_id', 'in', crustdataIds),
      condition('metadata.date_added', '>', after), condition('metadata.date_added', '<', through(end)),
      ...(familyOnly ? [group('or', allFamilyPhrases.map(phrase => condition('job_details.title', '[.]', phrase)))] : [])]),
    sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 1000,
    fields: ['crustdata_job_id', 'job_details.title', 'job_details.url', 'company.basic_info.crustdata_company_id', 'company.basic_info.name', 'metadata.date_added'],
    ...(cursor ? { cursor } : {}),
  }),
  parse(raw, { after, through: end }, meta) {
    const body = validate(jobResponse.extend({ next_cursor: str }), raw);
    const rows: OutcomeRow[] = [];
    const evidence: Evidence[] = [];
    for (const job of body.job_listings) {
      const day = job.metadata?.date_added?.slice(0, 10);
      const title = job.job_details?.title;
      const id = job.company?.basic_info?.crustdata_company_id;
      if (!day || !title || id == null || day <= after || day > end) continue;
      const row = evidenceRow(meta, String(job.crustdata_job_id ?? `${id}:${title}:${day}`), '$.job_details.title',
        `${job.company?.basic_info?.name ?? 'The company'} posted “${title}” on ${day}.`, day, title, job.job_details?.url);
      evidence.push(row);
      rows.push({ crustdataId: id, kind: 'job_post', date: day, title, roleFamily: roleFamily(title), evidenceId: row.id });
    }
    return { rows, evidence, nextCursor: body.next_cursor ?? null };
  },
  estimateCredits: raw => 0.03 * ((raw as { job_listings?: unknown[] } | null)?.job_listings?.length ?? 100),
};

/** Replay outcome read: hires into an infra/serving family at the given companies, starting in (after, through]. */
export const hireOutcomes: EndpointSpec<OutcomeInput, { rows: OutcomeRow[]; evidence: Evidence[]; nextCursor: string | null }> = {
  name: 'hire_outcomes', path: '/person/search', method: 'POST',
  build: ({ crustdataIds, after, through: end, cursor }) => ({
    filters: group('and', [condition(ROLE + 'current.company_id', 'in', crustdataIds),
      condition(ROLE + 'current.start_date', '>', after), condition(ROLE + 'current.start_date', '=<', end),
      group('or', allFamilyPhrases.map(phrase => condition(ROLE + 'current.title', '[.]', phrase)))]),
    limit: 200, fields: ['crustdata_person_id', ...['title', 'start_date', 'crustdata_company_id', 'name'].map(field => ROLE + 'current.' + field)],
    ...(cursor ? { cursor } : {}),
  }),
  parse(raw, { crustdataIds, after }, meta) {
    const body = validate(peopleResponse, raw);
    const rows: OutcomeRow[] = [];
    const evidence: Evidence[] = [];
    for (const person of body.profiles) for (const current of person.experience?.employment_details?.current ?? []) {
      if (current.crustdata_company_id == null || !crustdataIds.includes(current.crustdata_company_id) || !current.start_date) continue;
      const started = monthInterval(current.start_date);
      if (started[0] <= after) continue;                    // the whole month must be after the cutoff
      const row = evidenceRow(meta, `${person.crustdata_person_id}:${current.crustdata_company_id}:${current.start_date.slice(0, 7)}`,
        '$.experience.employment_details.current[].start_date',
        `${current.name} hired a ${current.title} who started in ${monthName(started[0])} (month precision).`, started[0], current.title!);
      evidence.push(row);
      rows.push({ crustdataId: current.crustdata_company_id, kind: 'hire', date: started[0], title: current.title!, roleFamily: roleFamily(current.title), evidenceId: row.id });
    }
    return { rows, evidence, nextCursor: body.next_cursor ?? null };
  },
  estimateCredits: raw => 0.23 * ((raw as { profiles?: unknown[] } | null)?.profiles?.length ?? 50),
};
