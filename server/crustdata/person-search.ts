import { z } from 'zod';
import type { Company, Intent, IsoDate, Person } from '../../shared/types.ts';
import { daysBetween, deciderPhrases, DRAIN_HISTORY_DAYS, DRAIN_REPLAY_HISTORY_DAYS, formatMonth, inWindow, isoDay, matchesDecider, matchesSignal, servingSignalKeywords, shiftDays, stableId } from '../domain/facts.ts';
import { PROFILE_LAG_DAYS } from '../domain/replay-guard.ts';
import type { ProfileEvidence } from '../domain/replay-guard.ts';
import type { CompanyMention, MoveTrigger, ParseMeta, PersonMention, TriggerBatch } from '../domain/types.ts';
import {
  companyFilter, companyNumber, condition, dates, emptyBatch, estimate, evidenceRow, geographyFilter, group, int,
  matchesGeography, sameCompany, sameEmployer, str, strs, validate,
} from './common.ts';
import type { CompanyInput } from './common.ts';
import type { EndpointSpec } from './spec.ts';

export const MOVES_LIMIT = 50;
const DECIDERS_LIMIT = 12;
const COHORT_DEPARTURES_LIMIT = 200;
const COHORT_LOOKBACK_DAYS = 90;
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
  position_id: z.union([z.number().int(), z.string()]).nullish(), name: str, title: str, start_date: str, end_date: str, is_default: z.boolean().nullish(),
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
type RoleEntry = {
  data: Role; path: string; start: IsoDate | null; end: IsoDate | null; current: boolean;
  startMonth: [IsoDate, IsoDate] | null; endMonth: [IsoDate, IsoDate] | null;
};

function monthBounds(value?: string | null): [IsoDate, IsoDate] | null {
  const month = value?.match(/^(\d{4}-\d{2})(?:-01T00:00:00(?:\.0+)?(?:Z|[+-]00:00)?)?$/)?.[1];
  if (!month) return null;
  const first = isoDay(month + '-01');
  return first ? [first, shiftDays(shiftDays(first, 32).slice(0, 7) + '-01', -1)] : null;
}

function beforeOrOn(date: IsoDate, cutoff: IsoDate) {
  return date < cutoff ? date : cutoff;
}

function datedRoleStart(role: RoleEntry, cutoff: IsoDate, useCurrentObservation: boolean) {
  return role.start ?? (role.startMonth
    ? useCurrentObservation ? beforeOrOn(role.startMonth[1], cutoff) : role.startMonth[1]
    : null);
}

export function buildPeopleMoves(intent: Intent, after: IsoDate, through: IsoDate, companies?: CompanyInput[]) {
  const prefixes = companies || intent.runKind === 'replay' ? [CURRENT, PAST] : [CURRENT];
  const keywords = [...new Set([...intent.signalKeywords, ...servingSignalKeywords])].filter(keyword => keyword.trim());
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
  return (['current', 'past'] as const).flatMap(kind => (details?.[kind] ?? []).map((data, index) => {
    const startMonth = monthBounds(data.start_date);
    const endMonth = monthBounds(data.end_date);
    return {
      data, path: '$.' + EMPLOYMENT + '.' + kind + (data.position_id != null && data.position_id !== ''
        ? '[?(@.position_id == ' + JSON.stringify(data.position_id) + ')]' : '[' + index + ']'),
      start: startMonth ? null : isoDay(data.start_date), end: endMonth ? null : isoDay(data.end_date),
      current: kind === 'current', startMonth, endMonth,
    };
  }));
}

function roleEmployer(data: Role): CompanyInput {
  return { name: data.name?.trim() ?? '', domain: data.company_website, crustdataId: data.crustdata_company_id };
}

function employer(role: RoleEntry, key: string, historical: boolean): CompanyMention | null {
  const identity = roleEmployer(role.data);
  if (!identity.name) return null;
  const data = role.data;
  return {
    ...identity, key, linkedinUrl: data.company_professional_network_profile_url, hq: data.company_headquarters_country,
    industry: historical ? undefined : data.company_industries?.[0] || data.company_professional_network_industry,
    categories: historical ? undefined : data.company_industries ?? undefined,
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
  return work.flatMap(role => {
    const end = role.end ?? role.endMonth?.[1];
    const start = role.start ?? role.startMonth?.[1];
    if (!end || end > through || !role.data.name) return [];
    return [{ name: role.data.name, companyId: companyKeys?.get(role), title: role.data.title,
      from: start && start <= through ? start : null, to: end }];
  });
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
      if (!title || !matchesSignal(title, [...intent.signalKeywords, ...servingSignalKeywords])) return false;
      const earliest = role.start ?? role.startMonth?.[0];
      const latest = datedRoleStart(role, through, !historical);
      if (companies) {
        const company = employer(role, '', true);
        return Boolean(company && companies.some(target => sameEmployer(target, company)) && earliest &&
          earliest > after && inWindow(latest, after, through));
      }
      if (!matchesGeography(role.data.company_headquarters_country, intent.geography)) return false;
      if (historical) {
        const firstPossibleEnd = role.end ?? role.endMonth?.[0];
        return inWindow(latest, after, shiftDays(through, -PROFILE_LAG_DAYS)) && (firstPossibleEnd
          ? firstPossibleEnd > through : role.current);
      }
      if (!role.current || role.end || role.endMonth) return false;
      if (role.startMonth) return role.startMonth[1] > after && role.startMonth[0] <= through;
      return role.start === null || inWindow(role.start, after, through);
    }).sort((a, b) => Number(Boolean(b.data.is_default)) - Number(Boolean(a.data.is_default)) ||
      (b.start ?? '').localeCompare(a.start ?? ''));

    for (const role of companies ? eligible : eligible.slice(0, 1)) {
      const title = role.data.title!;
      const at = datedRoleStart(role, through, !historical);
      const movementDate = at;
      const dateLabel = role.startMonth ? formatMonth(role.startMonth[0]) : at;
      const precisionNote = role.startMonth ? ' (month precision)' : '';
      const position = String(role.data.position_id ?? '') || stableId('position_', role.data.name || '', title, at || '');
      const mentionKey = 'person_recent_moves:' + recordId + ':' + position;
      const next = employer(role, mentionKey + ':company', historical);
      if (!next || seen.has(mentionKey)) continue;
      seen.add(mentionKey);
      const hireFact: ProfileEvidence = evidenceRow(meta, recordId, role.path + '.start_date',
        dateLabel ? `An employee started as ${title} at ${next.name} ${role.startMonth ? 'in' : 'on'} ${dateLabel}${precisionNote}.` : `${next.name} listed an employee as ${title}.`,
        at, title, url);
      if (at) hireFact.profileRoleStartedAt = at;
      next.evidenceIds.push(hireFact.id);
      batch.evidence.push(hireFact);
      batch.mentions.push(next);
      const companyKeys = new Map<RoleEntry, string>();
      const recentPrevious = movementDate && !companies ? work.filter(other => {
        const earliestEnd = other.end ?? other.endMonth?.[0];
        const latestEnd = other.end ?? other.endMonth?.[1];
        return other !== role && earliestEnd && latestEnd && earliestEnd <= movementDate &&
          daysBetween(latestEnd, role.startMonth?.[0] ?? movementDate) <= 60 && other.data.name &&
          (!other.start || other.start <= latestEnd);
      }).sort((a, b) => (b.end ?? b.endMonth?.[1] ?? '').localeCompare(a.end ?? a.endMonth?.[1] ?? ''))[0] : undefined;

      const previous = recentPrevious && employer(recentPrevious, mentionKey + ':previous', historical);
      let moveEvidence = [hireFact.id];
      if (recentPrevious && previous) {
        const end = recentPrevious.end ?? (recentPrevious.endMonth ? beforeOrOn(recentPrevious.endMonth[1], through) : null);
        const endLabel = recentPrevious.endMonth ? ' in ' + formatMonth(recentPrevious.endMonth[0]) + ' (month precision)' : end ? ' on ' + end : '';
        const pastFact: ProfileEvidence = evidenceRow(meta, recordId, recentPrevious.path + '.end_date',
          `An employee's ${recentPrevious.data.title || 'role'} at ${previous.name} ended${endLabel}.`,
          end, recentPrevious.data.title, url);
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
      if (!movementDate) continue;
      const move: NonNullable<MoveTrigger['move']> = {
        currentTitle: title, previousTitle: recentPrevious?.data.title,
        datePrecision: role.startMonth ? 'month' : 'day',
        startInterval: role.startMonth ? [role.startMonth[0], movementDate] : undefined,
        previousEndInterval: recentPrevious?.endMonth ?? undefined,
      };
      const hire: MoveTrigger = {
        id: stableId('tr_', 'hire', recordId, position), companyId: next.key, kind: 'hire', date: movementDate,
        summary: `filled a ${title} role ${role.startMonth ? 'in' : 'on'} ${dateLabel}`,
        personId: mentionKey, relatedCompanyId: previous?.key ?? null, evidenceIds: moveEvidence, move,
      };
      batch.triggers.push(hire);
      if (previous) {
        const departure: MoveTrigger = {
          ...hire, id: stableId('tr_', 'departure', recordId, position), companyId: previous.key, kind: 'departure',
          relatedCompanyId: next.key, summary: `an infrastructure employee moved ${role.startMonth ? 'in' : 'on'} ${dateLabel}`,
        };
        batch.triggers.push(departure);
      }

    }
  }
  return batch;
}

export const personSearchRecentMoves: EndpointSpec<{ intent: Intent }, TriggerBatch> = {
  name: 'person_recent_moves', path: '/person/search', method: 'POST',
  build: ({ intent }) => buildPeopleMoves(intent, shiftDays(intent.asOf, -(intent.runKind === 'replay' ? DRAIN_REPLAY_HISTORY_DAYS : DRAIN_HISTORY_DAYS)),
    intent.runKind === 'replay' ? shiftDays(intent.asOf, -PROFILE_LAG_DAYS) : intent.asOf),
  parse: (raw, { intent }, meta) => parsePeopleMoves(raw, intent, meta, shiftDays(intent.asOf, -(intent.runKind === 'replay' ? DRAIN_REPLAY_HISTORY_DAYS : DRAIN_HISTORY_DAYS)), intent.asOf),
  estimateCredits: raw => estimate(raw, 'profiles', MOVES_LIMIT, 0.23),
};

type CohortInput = { intent: Intent; companies: CompanyInput[] };

function cohortWindow(intent: Intent) {
  return {
    since: shiftDays(intent.asOf, -COHORT_LOOKBACK_DAYS),
    through: intent.runKind === 'replay' ? shiftDays(intent.asOf, -PROFILE_LAG_DAYS) : intent.asOf,
  };
}

function cohortKeywords(intent: Intent) {
  const keywords = intent.signalKeywords.filter(keyword => keyword.trim());
  return keywords.length ? keywords : ['inference', 'ML infrastructure', 'ML platform', 'GPU', 'model serving'];
}

export const personCohortDepartures: EndpointSpec<CohortInput, TriggerBatch> = {
  name: 'person_cohort_departures', path: '/person/search', method: 'POST',
  build({ intent, companies }) {
    const ids = [...new Set(companies.flatMap(company => companyNumber(company.crustdataId) ?? []))];
    const { since, through } = cohortWindow(intent);
    return {
      filters: group('and', [
        // The API indexes the response's crustdata_company_id under company_id.
        condition(PAST + '.company_id', 'in', ids.length ? ids : [-1]),
        group('or', cohortKeywords(intent).map(keyword => condition(PAST + '.title', '[.]', keyword))),
        ...dates(CURRENT + '.start_date', shiftDays(since, -1), through),
      ]),
      fields: [...basicFields, ...[CURRENT, PAST].flatMap(prefix => roleFields.map(field => prefix + '.' + field))],
      // Person Search supports sorting on the employment-level date index.
      sorts: [{ field: EMPLOYMENT + '.start_date', order: 'desc' }],
      limit: COHORT_DEPARTURES_LIMIT,
    };
  },
  parse(raw, { intent, companies }, meta) {
    const { since, through } = cohortWindow(intent);
    const keywords = cohortKeywords(intent);
    const byId = new Map(companies.map(company => [companyNumber(company.crustdataId), company]));
    const batch = emptyBatch();
    const seen = new Set<string>();
    const profiles = validate(personResponse, raw).profiles;

    for (const profile of profiles) {
      const name = profile.basic_profile?.name?.trim();
      const url = profileUrl(profile);
      if (profile.crustdata_person_id == null && !name && !url) continue;
      const recordId = profileId(profile);
      const work = roles(profile);
      const active = work.filter(role => role.current && !role.end && !role.endMonth);
      const hires = active.flatMap(role => {
        const start = datedRoleStart(role, through, intent.runKind === 'live');
        const first = role.startMonth?.[0] ?? start;
        return start && first && start >= since && first <= through && start <= through && role.data.title
          ? [{ role, start }] : [];
      }).sort((a, b) => a.start.localeCompare(b.start) || Number(Boolean(b.role.data.is_default)) - Number(Boolean(a.role.data.is_default)));
      const previousRoles = work.flatMap(role => {
        const first = role.end ?? role.endMonth?.[0];
        const last = role.end ?? role.endMonth?.[1];
        const end = last && intent.runKind === 'live' && role.endMonth ? beforeOrOn(last, through) : last;
        return !role.current && first && end && first <= through && end >= since && end <= through
          && (!role.start || role.start <= end) && role.data.title && matchesSignal(role.data.title, keywords)
          ? [{ role, first, end }] : [];
      }).sort((a, b) => b.end.localeCompare(a.end));

      for (const { role: previous, first, end: departedAt } of previousRoles) {
        const companyId = companyNumber(previous.data.crustdata_company_id);
        const company = companyId === null ? undefined : byId.get(companyId);
        const moveKey = `person_cohort_departures:${recordId}:${companyId}`;
        if (!company || seen.has(moveKey) || active.some(role => sameCompany(roleEmployer(role.data), company))) continue;
        const arrivalRole = hires.find(({ role, start }) => start >= first && role.data.name?.trim());
        if (!arrivalRole) continue;
        const { role: hire, start: hiredAt } = arrivalRole;

        const next = employer(hire, moveKey + ':destination', intent.runKind === 'replay')!;
        const origin: CompanyMention = { ...company, key: moveKey + ':origin', evidenceIds: [] };
        const pastTitle = previous.data.title!;
        const newTitle = hire.data.title!;
        const endLabel = previous.endMonth ? `in ${formatMonth(first)} (month precision)` : `on ${departedAt}`;
        const startLabel = hire.startMonth ? `in ${formatMonth(hire.startMonth[0])} (month precision)` : `on ${hiredAt}`;
        const departure: ProfileEvidence = evidenceRow(meta, recordId, previous.path + '.end_date',
          `An employee's ${pastTitle} role at ${origin.name} ended ${endLabel}.`, departedAt, pastTitle, url);
        const arrival: ProfileEvidence = evidenceRow(meta, recordId, hire.path + '.start_date',
          `An employee started as ${newTitle} at ${next.name} ${startLabel}.`, hiredAt, newTitle, url);
        departure.profileRoleStartedAt = arrival.profileRoleStartedAt = hiredAt;
        origin.evidenceIds.push(departure.id);
        next.evidenceIds.push(arrival.id);
        const evidenceIds = [departure.id, arrival.id];
        seen.add(moveKey);
        batch.mentions.push(origin, next);
        batch.evidence.push(departure, arrival);
        if (name) batch.people.push({
          key: moveKey, name, title: newTitle, companyKey: next.key, linkedinUrl: url, startedAt: hiredAt,
          pastEmployers: pastEmployers(work, through, new Map([[previous, origin.key]])), evidenceIds,
        });
        const hireTrigger: MoveTrigger = {
          id: stableId('tr_', 'cohort_hire', moveKey), companyId: next.key, kind: 'hire', date: hiredAt,
          summary: `filled a ${newTitle} role ${startLabel}`, personId: name ? moveKey : null,
          relatedCompanyId: origin.key, evidenceIds,
          move: { currentTitle: newTitle, previousTitle: pastTitle, datePrecision: hire.startMonth ? 'month' : 'day',
            startInterval: hire.startMonth ? [hire.startMonth[0], hiredAt] : undefined,
            previousEndInterval: previous.endMonth ?? undefined },
        };
        const departureTrigger: MoveTrigger = { ...hireTrigger,
          id: stableId('tr_', 'cohort_departure', moveKey), companyId: origin.key, kind: 'departure', date: departedAt,
          summary: `an employee left a ${pastTitle} role ${endLabel}`, relatedCompanyId: next.key,
        };
        batch.triggers.push(departureTrigger, hireTrigger);
      }
    }
    return batch;
  },
  estimateCredits: raw => estimate(raw, 'profiles', COHORT_DEPARTURES_LIMIT, 0.23),
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
        if (!sameEmployer(company, roleEmployer(entry.data)) || !entry.data.title ||
          !matchesDecider(entry.data.title, intent.deciderTitles)) return false;
        if (intent.runKind === 'replay') {
          const lastPossibleStart = datedRoleStart(entry, intent.asOf, false);
          const firstPossibleEnd = entry.end ?? entry.endMonth?.[0];
          return lastPossibleStart && lastPossibleStart <= shiftDays(intent.asOf, -PROFILE_LAG_DAYS)
            && (firstPossibleEnd ? firstPossibleEnd > intent.asOf : entry.current);
        }
        const firstPossibleStart = entry.start ?? entry.startMonth?.[0];
        return entry.current && (!firstPossibleStart || firstPossibleStart <= intent.asOf) && !entry.end && !entry.endMonth;
      });
      if (!role) continue;
      const recordId = profileId(profile);
      const title = role.data.title!;
      const url = profileUrl(profile);
      const start = datedRoleStart(role, intent.asOf, intent.runKind !== 'replay');
      const startLabel = role.startMonth ? ' in ' + formatMonth(role.startMonth[0]) + ' (month precision)' : start ? ' on ' + start : '';
      const fact: ProfileEvidence = evidenceRow(meta, recordId, role.path + '.title',
        start ? `${name} started as ${title} at ${company.name}${startLabel}.`
          : `${name} is listed as ${title} at ${company.name}.`,
        start, title, url);
      if (start) fact.profileRoleStartedAt = start;
      const historyFacts = work.flatMap(entry => {
        const end = entry.end ?? entry.endMonth?.[1];
        if (!end || end > intent.asOf || !entry.data.name) return [];
        const startLabel = entry.startMonth ? formatMonth(entry.startMonth[0]) : entry.start;
        const endLabel = entry.endMonth ? formatMonth(entry.endMonth[0]) : end;
        const precision = entry.startMonth || entry.endMonth ? ' (month precision)' : '';
        return [evidenceRow(meta, recordId, entry.path + '.end_date',
          `${name} worked at ${entry.data.name}${startLabel ? ' from ' + startLabel : ''} until ${endLabel}${precision}.`,
          end, entry.data.name, url)];
      });
      evidence.push(fact, ...historyFacts);
      people.push({ key: 'person_deciders:' + recordId, name, title, companyKey: company.id, linkedinUrl: url, startedAt: start,
        pastEmployers: pastEmployers(work, intent.asOf), evidenceIds: [fact.id, ...historyFacts.map(row => row.id)] });
    }
    return { people, evidence };
  },
  estimateCredits: raw => estimate(raw, 'profiles', DECIDERS_LIMIT, 0.23),
};
