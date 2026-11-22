// POST /person/enrich (Crustdata, x-api-version 2025-11-01): one consenting candidate's own public profile.
// Data minimisation happens at the request: only the field groups the candidate consented to are asked for, and the
// parser keeps only a display name (first name + last initial), headline, title, skills and dated roles. The tool
// wrapper already strips email/phone keys from every live response before it is parsed or cached.
import { z } from 'zod';
import { LINKEDIN_URL_MAX } from '../../shared/desk.ts';
import type { Evidence, IsoDate } from '../../shared/types.ts';
import { isoDay, stableId } from '../domain/facts.ts';
import type { ParseMeta, PersonMention } from '../domain/types.ts';
import { evidenceRow, int, str, strs, validate } from './common.ts';
import type { EndpointSpec } from './spec.ts';

export interface EnrichInput {
  profileUrl: string;
  shareHistory: boolean;
  shareSkills: boolean;
}
export interface EnrichResult {
  evidence: Evidence[];
  people: PersonMention[];
}

const EMPLOYMENT = 'experience.employment_details';
const SKILLS = 'skills.professional_network_skills';
const MAX_SKILLS = 30;
const MAX_ROLES = 12;

// Accepts https://www.linkedin.com/in/<slug>[/] (any linkedin.com subdomain), nothing else.
export function linkedinProfileUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > LINKEDIN_URL_MAX) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  const slug = url.pathname.match(/^\/in\/([A-Za-z0-9\-_%.]{2,100})\/?$/)?.[1];
  return slug ? `https://www.linkedin.com/in/${slug}/` : null;
}

// "Asha Kestrel" -> "Asha K."; a single name stays as given; never more than first name + last initial.
export function displayName(name: string | null | undefined): string {
  const parts = (name ?? '').replace(/[,(].*$/, '').trim().split(/\s+/).filter(part => /\p{L}/u.test(part));
  if (!parts.length) return 'Candidate';
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? `${first} ${last.match(/\p{L}/u)![0].toUpperCase()}.` : first;
}

const roleSchema = z.object({
  name: str, title: str, start_date: str, end_date: str, crustdata_company_id: int,
}).passthrough();
const personData = z.object({
  crustdata_person_id: int,
  basic_profile: z.object({ name: str, headline: str, current_title: str }).passthrough().nullish(),
  skills: z.object({ professional_network_skills: strs }).passthrough().nullish(),
  experience: z.object({
    employment_details: z.object({ current: z.array(roleSchema).nullish(), past: z.array(roleSchema).nullish() }).passthrough().nullish(),
  }).passthrough().nullish(),
}).passthrough();
const response = z.array(z.object({
  matched_on: str,
  match_status: str,
  matches: z.array(z.object({ confidence_score: z.number().nullish(), person_data: personData.nullish() }).passthrough()).nullish(),
}).passthrough());

const month = (value?: string | null): IsoDate | null => {
  const day = isoDay(value ?? undefined);
  return day ? day.slice(0, 7) + '-01' : null;
};
const monthLabel = (date: IsoDate | null) => date
  ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;

export function parseEnrich(raw: unknown, input: EnrichInput, meta: ParseMeta): EnrichResult {
  const rows = validate(response, raw);
  const match = rows.flatMap(row => row.match_status === 'redacted' ? [] : row.matches ?? [])
    .filter(row => row.person_data).sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))[0];
  const person = match?.person_data;
  if (!person) return { evidence: [], people: [] };
  const recordId = String(person.crustdata_person_id ?? stableId('person_', input.profileUrl));
  const observed = meta.asOf;
  const evidence: Evidence[] = [];
  const add = (field: string, claim: string, value: string, observedAt: IsoDate | null = observed) => {
    const row = evidenceRow(meta, recordId, field, claim, observedAt, value, input.profileUrl);
    evidence.push(row);
    return row;
  };
  const basic = person.basic_profile;
  const headline = basic?.headline?.trim().slice(0, 200) || null;
  const title = basic?.current_title?.trim().slice(0, 120) || null;
  if (headline) add('basic_profile.headline', `The candidate's profile headline reads "${headline}".`, headline);
  if (title) add('basic_profile.current_title', `The candidate's profile lists the current title ${title}.`, title);

  const skills = input.shareSkills ? [...new Set((person.skills?.professional_network_skills ?? [])
    .map(skill => skill.trim()).filter(skill => skill && skill.length <= 60))].slice(0, MAX_SKILLS) : [];
  if (skills.length) add(SKILLS, `The candidate's profile lists ${skills.length} skills: ${skills.join(', ')}.`, skills.join('; '));

  const pastEmployers: PersonMention['pastEmployers'] = [];
  if (input.shareHistory) {
    const details = person.experience?.employment_details;
    const roles = (['current', 'past'] as const).flatMap(kind => (details?.[kind] ?? []).map((role, index) => ({ role, kind, index })))
      .filter(({ role }) => role.name?.trim() && role.title?.trim()).slice(0, MAX_ROLES);
    for (const { role, kind, index } of roles) {
      const from = month(role.start_date);
      const to = kind === 'current' ? null : month(role.end_date);
      const span = [monthLabel(from) ? `from ${monthLabel(from)}` : null, kind === 'current' ? 'to now' : monthLabel(to) ? `to ${monthLabel(to)}` : null]
        .filter(Boolean).join(' ');
      add(`${EMPLOYMENT}.${kind}[${index}]`, `The candidate's profile lists ${role.title!.trim()} at ${role.name!.trim()}${span ? ' ' + span : ''}.`,
        role.title!.trim(), from ?? observed);
      pastEmployers.push({ name: role.name!.trim(), title: role.title!.trim(), from, to });
    }
  }
  return {
    evidence,
    people: [{
      key: 'candidate:' + recordId, name: displayName(basic?.name), title: title ?? headline ?? '', companyKey: null,
      linkedinUrl: input.profileUrl, startedAt: pastEmployers.find(item => item.to === null)?.from ?? null, pastEmployers,
      evidenceIds: evidence.map(row => row.id),
    }],
  };
}

export const personEnrich: EndpointSpec<EnrichInput, EnrichResult> = {
  name: 'person_enrich', path: '/person/enrich', method: 'POST',
  build: input => ({
    professional_network_profile_urls: [input.profileUrl],
    fields: ['basic_profile', ...(input.shareSkills ? ['skills'] : []), ...(input.shareHistory ? ['experience'] : [])],
  }),
  parse: parseEnrich,
  // Listed at 1-9 credits per profile (server/crustdata/NOTES.md); X-Credits-Used overrides this when present.
  estimateCredits: raw => raw === null ? 9 : Array.isArray(raw) && raw.some(row => (row as { matches?: unknown[] })?.matches?.length) ? 5 : 0,
};

// Labelled FICTIONAL candidate for keyless/fixture runs. No real person; the name and employers are invented.
export const FIXTURE_CANDIDATE_NAME = 'Asha Kestrel';
export function enrichFixture(body: unknown): unknown {
  const url = (body as { professional_network_profile_urls?: string[] })?.professional_network_profile_urls?.[0] ?? '';
  const fields = (body as { fields?: string[] })?.fields ?? [];
  return [{
    matched_on: url, match_type: 'professional_network_profile_url', match_status: 'matched',
    matches: [{
      confidence_score: 1,
      person_data: {
        crustdata_person_id: 900001,
        basic_profile: {
          name: FIXTURE_CANDIDATE_NAME, current_title: 'ML Platform Engineer',
          headline: 'ML platform engineer: training and serving infrastructure (fictional demo profile)',
        },
        ...(fields.includes('skills') && { skills: { professional_network_skills: [
          'Kubernetes', 'Ray', 'Kubeflow', 'MLflow', 'PyTorch', 'Feature stores', 'Terraform', 'Python', 'Model serving',
        ] } }),
        ...(fields.includes('experience') && { experience: { employment_details: {
          current: [{ name: 'Northwind Signal Labs', title: 'ML Platform Engineer', start_date: '2023-03-01', end_date: null }],
          past: [{ name: 'Brightfold Data', title: 'Data Engineer', start_date: '2020-06-01', end_date: '2023-02-01' }],
        } } }),
      },
    }],
  }];
}
