import { z } from 'zod';
import type { Company, Intent, IsoDate, Person } from '../../shared/types.ts';
import { daysBetween, deciderPhrases, inWindow, isoDay, matchesDecider, matchesSignal, shiftDays, stableId } from '../domain/facts.ts';
import { PROFILE_LAG_DAYS } from '../domain/replay-guard.ts';
import type { ProfileEvidence } from '../domain/replay-guard.ts';
import type { CompanyMention, ParseMeta, PersonMention, TriggerBatch } from '../domain/types.ts';
import {
  companyFilter, condition, dates, emptyBatch, estimate, evidenceRow, geographyFilter, group, int, matchesGeography,
  sameCompany, str, strs, validate,
} from './common.ts';
import type { CompanyInput } from './common.ts';
import type { EndpointSpec } from './spec.ts';

export const MOVES_LIMIT = 50;
const DECIDERS_LIMIT = 12;
const EMPLOYMENT = 'experience.employment_details';
export const CURRENT = EMPLOYMENT + '.current';
export const PAST = EMPLOYMENT + '.past';
const PROFILE_URL = 'social_handles.professional_network_identifier.profile_url';
const basicFields = ['basic_profile.name', PROFILE_URL];
const roleFields = [
  'position_id', 'name', 'title', 'start_date', 'end_date', 'is_default', 'crustdata_company_id', 'company_website',
  'company_professional_network_profile_url', 'company_professional_network_industry',
  'company_industries', 'company_headcount_latest', 'company_headquarters_country',
];
const deciderRoleFields = ['position_id', 'name', 'title', 'start_date', 'end_date', 'crustdata_company_id', 'company_website'];
const roleSchema = z.object({
  position_id: str, name: str, title: str, start_date: str, end_date: str, is_default: z.boolean().nullish(),
  crustdata_company_id: int, company_website: str, company_professional_network_profile_url: str,
  company_professional_network_industry: str, company_industries: strs, company_headcount_latest: int,
  company_headquarters_country: str,
}).passthrough();

const personResponse = z.object({
  profiles: z.array(z.object({
    crustdata_person_id: int,
    basic_profile: z.object({ name: str }).passthrough().nullish(),
    social_handles: z.object({
      professional_network_identifier: z.object({ profile_url: str }).passthrough().nullish(),
    }).passthrough().nullish(),
    experience: z.object({
      employment_details: z.object({
        current: z.array(roleSchema).nullish(), past: z.array(roleSchema).nullish(),
      }).passthrough().nullish(),
    }).passthrough().nullish(),
  }).passthrough()),
}).passthrough();

type Profile = z.infer<typeof personResponse>['profiles'][number];
type Role = z.infer<typeof roleSchema>;
type RoleEntry = { data: Role; path: string; start: IsoDate | null; end: IsoDate | null; current: boolean };

export function buildPeopleMoves(intent: Intent, after: IsoDate, through: IsoDate, companies?: CompanyInput[]) {
  const prefixes = companies || intent.runKind === 'replay' ? [CURRENT, PAST] : [CURRENT];
  const keywords = intent.signalKeywords.filter(keyword => keyword.trim());
  return {
    filters: group('or', prefixes.map(prefix => group('and', [
      ...dates(prefix + '.start_date', after, through),
      ...(keywords.length ? [group('or', keywords.map(keyword => condition(prefix + '.title', '[.]', keyword)))] : []),
      ...geographyFilter(prefix + '.company_headquarters_country', companies ? null : intent.geography),
      ...(companies ? [companyFilter(companies, employerPaths(prefix))] : []),
    ]))),
    fields: [...basicFields, ...[CURRENT, PAST].flatMap(prefix => roleFields.map(field => prefix + '.' + field))],
    sorts: [{ field: EMPLOYMENT + '.start_date', order: 'desc' }],
    limit: MOVES_LIMIT,
  };
}

function employerPaths(prefix: string) {
  return { id: prefix + '.company_id', domain: prefix + '.company_website_domain', name: prefix + '.company_name' };
}

function roles(profile: Profile): RoleEntry[] {
  const details = profile.experience?.employment_details;
  return (['current', 'past'] as const).flatMap(kind => (details?.[kind] ?? []).map((data, index) => ({
    data, path: '$.' + EMPLOYMENT + '.' + kind + (data.position_id
      ? '[?(@.position_id == ' + JSON.stringify(data.position_id) + ')]' : '[' + index + ']'),
    start: isoDay(data.start_date), end: isoDay(data.end_date), current: kind === 'current',
  })));
}

function employer(role: RoleEntry, key: string, historical: boolean): CompanyMention | null {
  const data = role.data;
  const name = data.name?.trim();
  if (!name) return null;
  return {
    key, name, domain: data.company_website, linkedinUrl: data.company_professional_network_profile_url,
    crustdataId: data.crustdata_company_id, hq: data.company_headquarters_country,
    industry: historical ? undefined : data.company_industries?.[0] || data.company_professional_network_industry,
    headcount: historical ? undefined : data.company_headcount_latest, evidenceIds: [],
  };
}

function profileUrl(profile: Profile) {
  return profile.social_handles?.professional_network_identifier?.profile_url;
}

function profileId(profile: Profile) {
  return String(profile.crustdata_person_id ?? stableId('profile_', profileUrl(profile) || '', profile.basic_profile?.name || ''));
}

function pastEmployers(work: RoleEntry[], through: IsoDate, companyKeys?: Map<RoleEntry, string>): Person['pastEmployers'] {
  return work.filter(role => role.end && role.end <= through && role.data.name).map(role => ({
    name: role.data.name!, companyId: companyKeys?.get(role), title: role.data.title,
    from: role.start && role.start <= through ? role.start : null, to: role.end,
  }));
}

export function parsePeopleMoves(raw: unknown, intent: Intent, meta: ParseMeta, after: IsoDate, through: IsoDate,
  companies?: CompanyInput[]): TriggerBatch {
  const batch = emptyBatch();
  const historical = !companies && intent.runKind === 'replay';
  const seen = new Set<string>();
  for (const profile of validate(personResponse, raw).profiles) {
    const name = profile.basic_profile?.name?.trim();
    if (!name) continue;
    const recordId = profileId(profile);
    const url = profileUrl(profile);
    const work = roles(profile);
    const eligible = work.filter(role => {
      const title = role.data.title;
      if (!title || !matchesSignal(title, intent.signalKeywords)) return false;
      if (companies) {
        const company = employer(role, '', true);
        return Boolean(company && companies.some(target => sameCompany(target, company)) && inWindow(role.start, after, through));
      }
      if (!matchesGeography(role.data.company_headquarters_country, intent.geography)) return false;
      if (historical) return inWindow(role.start, after, through) && role.start <= shiftDays(through, -PROFILE_LAG_DAYS)
        && (role.end ? role.end > through : role.current);
      return role.current && !role.end && (role.start === null || inWindow(role.start, after, through));
    }).sort((a, b) => Number(Boolean(b.data.is_default)) - Number(Boolean(a.data.is_default)) ||
      (b.start ?? '').localeCompare(a.start ?? ''));

    for (const role of companies ? eligible : eligible.slice(0, 1)) {
      const title = role.data.title!;
      const at = role.start;
      const position = role.data.position_id || stableId('position_', role.data.name || '', title, at || '');
      const mentionKey = 'person_recent_moves:' + recordId + ':' + position;
      const next = employer(role, mentionKey + ':company', historical);
      if (!next || seen.has(mentionKey)) continue;
      seen.add(mentionKey);
      const hireFact: ProfileEvidence = evidenceRow(meta, recordId, role.path + '.start_date',
        at ? `An employee started as ${title} at ${next.name} on ${at}.` : `${next.name} listed an employee as ${title}.`,
        at, title, url);
      if (at) hireFact.profileRoleStartedAt = at;
      next.evidenceIds.push(hireFact.id);
      batch.evidence.push(hireFact);
      batch.mentions.push(next);
      const companyKeys = new Map<RoleEntry, string>();
      const recentPrevious = at && !companies ? work.filter(other => other !== role && other.end && other.end <= at
        && daysBetween(other.end, at) <= 60 && other.data.name &&
        (!other.start || other.start <= other.end)).sort((a, b) => b.end!.localeCompare(a.end!))[0] : undefined;
      const previous = recentPrevious && employer(recentPrevious, mentionKey + ':previous', historical);
      let moveEvidence = [hireFact.id];
      if (recentPrevious && previous) {
        const pastFact: ProfileEvidence = evidenceRow(meta, recordId, recentPrevious.path + '.end_date',
          `An employee's ${recentPrevious.data.title || 'role'} at ${previous.name} ended on ${recentPrevious.end}.`,
          recentPrevious.end, recentPrevious.data.title, url);
        if (at) pastFact.profileRoleStartedAt = at;
        moveEvidence = [...moveEvidence, pastFact.id];
        previous.evidenceIds.push(pastFact.id);
        companyKeys.set(recentPrevious, previous.key);
        batch.mentions.push(previous);
        batch.evidence.push(pastFact);
      }
      if (!companies) batch.people.push({
        key: mentionKey, name, title, companyKey: next.key, linkedinUrl: url, startedAt: at,
        pastEmployers: pastEmployers(work, through, companyKeys), evidenceIds: moveEvidence,
      });
      if (!at) continue;
      batch.triggers.push({
        id: stableId('tr_', 'hire', recordId, position), companyId: next.key, kind: 'hire', date: at,
        summary: `filled a ${title} role on ${at}`, personId: mentionKey, relatedCompanyId: previous?.key ?? null,
        evidenceIds: moveEvidence,
      });
      if (previous) batch.triggers.push({
        id: stableId('tr_', 'departure', recordId, position), companyId: previous.key, kind: 'departure', date: at,
        summary: `an infrastructure employee moved on ${at}`, personId: mentionKey, relatedCompanyId: next.key,
        evidenceIds: moveEvidence,
      });
    }
  }
  return batch;
}

export const personSearchRecentMoves: EndpointSpec<{ intent: Intent }, TriggerBatch> = {
  name: 'person_recent_moves', path: '/person/search', method: 'POST',
  build: ({ intent }) => buildPeopleMoves(intent, shiftDays(intent.asOf, -intent.windowDays),
    intent.runKind === 'replay' ? shiftDays(intent.asOf, -PROFILE_LAG_DAYS) : intent.asOf),
  parse: (raw, { intent }, meta) => parsePeopleMoves(raw, intent, meta, shiftDays(intent.asOf, -intent.windowDays), intent.asOf),
  estimateCredits: raw => estimate(raw, 'profiles', MOVES_LIMIT, 0.23),
};

export const personSearchDeciders: EndpointSpec<{ intent: Intent; company: Company }, Pick<TriggerBatch, 'people' | 'evidence'>> = {
  name: 'person_deciders', path: '/person/search', method: 'POST',
  build({ intent, company }) {
    const titles = deciderPhrases(intent.deciderTitles);
    const prefixes = intent.runKind === 'replay' ? [CURRENT, PAST] : [CURRENT];
    return {
      filters: group('or', prefixes.map(prefix => group('and', [
        companyFilter([company], employerPaths(prefix)),
        ...(titles.length ? [group('or', titles.map(title => condition(prefix + '.title', '[.]', title)))] : []),
        ...(intent.runKind === 'replay' ? [condition(prefix + '.start_date', '=<', shiftDays(intent.asOf, -PROFILE_LAG_DAYS))] : []),
      ]))),
      fields: [...basicFields, ...[CURRENT, PAST].flatMap(prefix => deciderRoleFields.map(field => prefix + '.' + field))],
      sorts: [{ field: EMPLOYMENT + '.start_date', order: 'asc' }],
      limit: DECIDERS_LIMIT,
    };
  },
  parse(raw, { intent, company }, meta) {
    const people: PersonMention[] = [];
    const evidence: ProfileEvidence[] = [];
    for (const profile of validate(personResponse, raw).profiles) {
      const name = profile.basic_profile?.name?.trim();
      if (!name) continue;
      const work = roles(profile);
      const role = work.find(entry => {
        const atCompany = employer(entry, '', true);
        if (!atCompany || !sameCompany(company, atCompany) || !entry.data.title ||
          !matchesDecider(entry.data.title, intent.deciderTitles)) return false;
        if (intent.runKind === 'replay') {
          return entry.start && entry.start <= shiftDays(intent.asOf, -PROFILE_LAG_DAYS)
            && (entry.end ? entry.end > intent.asOf : entry.current);
        }
        return entry.current && (!entry.start || entry.start <= intent.asOf) && !entry.end;
      });
      if (!role) continue;
      const recordId = profileId(profile);
      const title = role.data.title!;
      const url = profileUrl(profile);
      const fact: ProfileEvidence = evidenceRow(meta, recordId, role.path + '.title',
        role.start ? `${name} started as ${title} at ${company.name} on ${role.start}.`
          : `${name} is listed as ${title} at ${company.name}.`,
        role.start, title, url);
      if (role.start) fact.profileRoleStartedAt = role.start;
      evidence.push(fact);
      people.push({ key: 'person_deciders:' + recordId, name, title, companyKey: company.id, linkedinUrl: url, startedAt: role.start,
        pastEmployers: pastEmployers(work, intent.asOf), evidenceIds: [fact.id] });
    }
    return { people, evidence };
  },
  estimateCredits: raw => estimate(raw, 'profiles', DECIDERS_LIMIT, 0.23),
};
