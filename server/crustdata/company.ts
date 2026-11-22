import { z } from 'zod';
import type { Company, Evidence, Intent, IsoDate } from '../../shared/types.ts';
import { inWindow, isoDay, normalizeDomain, shiftDays, stableId } from '../domain/facts.ts';
import type { CompanyMention, ParseMeta, TriggerBatch } from '../domain/types.ts';
import {
  companyNumber, condition, dates, emptyBatch, estimate, evidenceRow, geographyFilter, group, int, matchesGeography,
  num, sameCompany, str, strs, validate,
} from './common.ts';
import type { CompanyInput } from './common.ts';
import type { EndpointSpec } from './spec.ts';

const GROWTH_LIMIT = 40;
const GROWTH_RATE = 1.03; // 0.03 base + taxonomy, headcount and funding on both filter and response.
const JUMP_PCT = 15;
const FUNDRAISE_DATE = 'funding.last_fundraise_date';
const GROWTH_DATE = 'metadata.growth_calculation_date';
const MONTH_GROWTH = 'headcount.growth_percent.1m';

const companySchema = z.object({
  crustdata_company_id: int,
  basic_info: z.object({
    name: str, crustdata_company_id: int, primary_domain: str, website: str, professional_network_url: str, year_founded: int,
  }).passthrough().nullish(),
  taxonomy: z.object({
    professional_network_industry: str, professional_network_industries: strs, categories: strs,
  }).passthrough().nullish(),
  metadata: z.object({ growth_calculation_date: str }).passthrough().nullish(),
  locations: z.object({ country: str, headquarters: str }).passthrough().nullish(),
  headcount: z.object({
    total: int, growth_percent: z.record(num).nullish(),
    timeseries: z.array(z.object({ date: str, employee_count: int }).passthrough()).nullish(),
  }).passthrough().nullish(),
  funding: z.object({
    last_fundraise_date: str, last_round_type: str, last_round_amount_usd: num,
    acquisitions: z.array(z.object({
      acquirer_company_id: int, acquirer_company_name: str, acquiree_company_id: int, acquiree_company_name: str,
      announced_on_date: str, acquirer_crunchbase_url: str, acquiree_crunchbase_url: str,
    }).passthrough()).nullish(),
    acquired_by: z.array(z.object({ name: str, crustdata_company_id: int, date: str }).passthrough()).nullish(),
    milestones: z.array(z.object({ date: str, funding_date: str, round_type: str, amount_usd: num }).passthrough()).nullish(),
  }).passthrough().nullish(),
  competitors: z.object({ all_domains: strs }).passthrough().nullish(),
}).passthrough();
type CompanyRow = z.infer<typeof companySchema>;
const searchResponse = z.object({ companies: z.array(companySchema) }).passthrough();
const enrichResponse = z.array(z.object({
  matched_on: str, match_type: str,
  matches: z.array(z.object({ confidence_score: num, company_data: companySchema }).passthrough()),
}).passthrough());

function roundName(value?: string | null): string | null {
  if (!value?.trim()) return null;
  return value.replace(/_/g, ' ').replace(/\bseries ([a-z])\b/i, (_, letter: string) => 'Series ' + letter.toUpperCase());
}

const periods = [['1m', 'mom'], ['3m', 'qoq'], ['6m', 'six_months'], ['12m', 'yoy']] as const;

function toCompany(row: CompanyRow, meta: ParseMeta, prefix: string, historical: boolean) {
  const basic = row.basic_info;
  const name = basic?.name?.trim();
  if (!basic || !name) return null;
  const id = row.crustdata_company_id ?? basic.crustdata_company_id;
  const recordId = String(id ?? normalizeDomain(basic.primary_domain || basic.website) ?? name);
  const url = basic.professional_network_url || basic.website;
  const evidence: Evidence[] = [];
  const add = (field: string, claim: string, day: IsoDate | null, value?: Evidence['value']) => {
    const fact = evidenceRow(meta, recordId, '$.' + field, claim, day, value, url);
    evidence.push(fact);
    return fact;
  };
  const anchor = isoDay(row.metadata?.growth_calculation_date);
  const points = (row.headcount?.timeseries ?? []).flatMap((point, index) => {
    const date = isoDay(point.date);
    return date && date <= meta.asOf && point.employee_count != null ? [{ date, count: point.employee_count, index }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date));
  const latest = points[0];
  const anchorUsable = Boolean(anchor && anchor <= meta.asOf);
  const snapshotUsable = anchorUsable || (!historical && !anchor);
  const headcount = latest?.count ?? (snapshotUsable ? row.headcount?.total : undefined);
  const headcountDate = latest?.date ?? (snapshotUsable ? anchor : null);
  if (headcount != null) {
    const field = latest ? `headcount.timeseries[${latest.index}].employee_count` : 'headcount.total';
    add(field, `${name} had ${headcount} employees${headcountDate ? ' on ' + headcountDate : ' in the company profile'}.`, headcountDate, headcount);
  }

  const growthMap = row.headcount?.growth_percent;
  let growth: Company['headcountGrowthPct'];
  let growthFact: Evidence | undefined;
  const previous = latest && points.find(point => point.date <= shiftDays(latest.date, -28));
  if (latest && previous?.count && previous.date >= shiftDays(latest.date, -35)) {
    growth = { window: '1m', pct: Math.round((latest.count / previous.count - 1) * 1000) / 10 };
    add(`headcount.timeseries[${previous.index}].employee_count`,
      `${name} had ${previous.count} employees on ${previous.date}.`, previous.date, previous.count);
    growthFact = add('headcount.timeseries', `${name}’s headcount went from ${previous.count} on ${previous.date} to ${latest.count} on ${latest.date}.`,
      latest.date, growth.pct);
  } else if (growthMap && snapshotUsable) {
    for (const [window, alias] of periods) {
      const field = growthMap[window] == null ? alias : window;
      const pct = growthMap[field];
      if (pct == null) continue;
      growth = { window, pct };
      growthFact = add('headcount.growth_percent.' + field,
        `${name} reported ${pct}% headcount growth over ${window}${anchor ? ' through ' + anchor : ''}.`, anchor, pct);
      break;
    }
  }
  const headlineDate = isoDay(row.funding?.last_fundraise_date);
  const historicRound = (row.funding?.milestones ?? []).flatMap((round, index) => {
    const date = isoDay(round.funding_date ?? round.date);
    return date && date <= meta.asOf ? [{ ...round, date, index }] : [];
  }).sort((a, b) => b.date.localeCompare(a.date))[0];
  const useMilestone = historicRound && (!headlineDate || headlineDate > meta.asOf || historicRound.date > headlineDate);
  const fundingDate = useMilestone ? historicRound.date : headlineDate;
  const round = roundName(useMilestone ? historicRound.round_type : row.funding?.last_round_type);
  const amountUsd = useMilestone ? historicRound.amount_usd : row.funding?.last_round_amount_usd;
  let funding: Company['lastFunding'];
  let fundingFact: Evidence | undefined;
  if ((fundingDate && fundingDate <= meta.asOf) || (!historical && !fundingDate && (round || amountUsd != null))) {
    funding = { date: fundingDate, round, amountUsd };
    const amount = amountUsd != null ? ' of $' + amountUsd.toLocaleString('en-US') : '';
    const fundingField = useMilestone ? `funding.milestones[${historicRound.index}]`
      : 'funding.' + (amountUsd != null ? 'last_round_amount_usd' : round ? 'last_round_type' : 'last_fundraise_date');
    fundingFact = add(fundingField,
      `${name} reported a ${round ? round + ' round' : 'funding round'}${amount}${fundingDate ? ' on ' + fundingDate : ''}.`,
      fundingDate, amountUsd ?? round ?? fundingDate);
  }

  const hasFirmographics = !historical || meta.mode === 'fixture';
  const domain = basic.primary_domain || basic.website;
  const field = row.taxonomy?.professional_network_industry ? 'professional_network_industry'
    : row.taxonomy?.professional_network_industries?.[0] ? 'professional_network_industries[0]' : 'categories[0]';
  const industry = hasFirmographics ? row.taxonomy?.professional_network_industry || row.taxonomy?.professional_network_industries?.[0]
    || row.taxonomy?.categories?.[0] : undefined;
  const competitorDomains = hasFirmographics ? row.competitors?.all_domains?.flatMap(value => normalizeDomain(value) ?? []) ?? [] : [];
  if (industry) add('taxonomy.' + field, `The company profile classifies ${name} under ${industry}.`, null, industry);
  if (basic.year_founded != null && hasFirmographics) {
    add('basic_info.year_founded', `${name} was founded in ${basic.year_founded}.`, null, basic.year_founded);
  }

  const acquisitions = (row.funding?.acquisitions ?? []).flatMap(event => {
    const date = isoDay(event.announced_on_date);
    if ((date && date > meta.asOf) || !event.acquirer_company_name || !event.acquiree_company_name) return [];
    return [{ acquirer: event.acquirer_company_name, acquired: event.acquiree_company_name, acquirerId: event.acquirer_company_id,
      acquiredId: event.acquiree_company_id, date, sourceUrl: event.acquiree_crunchbase_url ?? event.acquirer_crunchbase_url ?? undefined }];
  });
  for (const event of row.funding?.acquired_by ?? []) {
    const date = isoDay(event.date);
    if (event.name && (!date || date <= meta.asOf)) acquisitions.push({
      acquirer: event.name, acquired: name, acquirerId: event.crustdata_company_id, acquiredId: id, date, sourceUrl: undefined,
    });
  }
  const mention: CompanyMention = {
    key: prefix + ':' + recordId + ':company', name, domain, linkedinUrl: basic.professional_network_url,
    crustdataId: id, headcount, headcountGrowthPct: growth, firmographicsAsOf: headcountDate,
    industry, hq: row.locations?.headquarters || row.locations?.country, foundedYear: hasFirmographics ? basic.year_founded : undefined,
    lastFunding: funding, acquisitions, competitorNames: [], competitorDomains, evidenceIds: evidence.map(row => row.id),
  };
  return { mention, evidence, recordId, growth, growthFact, fundingFact };
}

function companySignals(row: NonNullable<ReturnType<typeof toCompany>>, intent: Pick<Intent, 'asOf' | 'windowDays'>) {
  const triggers: TriggerBatch['triggers'] = [];
  const after = shiftDays(intent.asOf, -intent.windowDays);
  const { mention, recordId, fundingFact, growth, growthFact } = row;
  if (fundingFact && inWindow(fundingFact.observedAt, after, intent.asOf)) triggers.push({
    id: stableId('tr_', 'funding', recordId, fundingFact.observedAt), companyId: mention.key, kind: 'funding',
    date: fundingFact.observedAt, summary: `reported ${mention.lastFunding?.round || 'funding'} on ${fundingFact.observedAt}`,
    evidenceIds: [fundingFact.id],
  });
  const growthDate = growthFact?.observedAt ?? null;
  if (growth?.window === '1m' && growth.pct >= JUMP_PCT && growthFact && inWindow(growthDate, after, intent.asOf)) {
    triggers.push({
      id: stableId('tr_', 'headcount_jump', recordId, growthDate), companyId: mention.key, kind: 'headcount_jump', date: growthDate,
      summary: `headcount grew ${growth.pct}% over one month through ${growthDate}`,
      evidenceIds: [growthFact.id],
    });
  }
  return triggers;
}

export const companySearchGrowth: EndpointSpec<{ intent: Intent }, TriggerBatch> = {
  name: 'company_growth', path: '/company/search', method: 'POST',
  build({ intent }) {
    const after = shiftDays(intent.asOf, -intent.windowDays);
    return {
      filters: group('and', [
        group('or', [
          ...['Artificial Intelligence', 'Machine Learning'].map(value => condition('taxonomy.categories', '[.]', value)),
          ...['Artificial Intelligence', 'Machine Learning'].map(value => condition('basic_info.industries', '[.]', value)),
        ]),
        ...geographyFilter('locations.country', intent.geography),
        group('or', [
          group('and', dates(FUNDRAISE_DATE, after, intent.asOf)),
          group('and', [...dates(GROWTH_DATE, after, intent.asOf), condition(MONTH_GROWTH, '=>', JUMP_PCT)]),
        ]),
      ]),
      fields: ['basic_info', 'taxonomy.categories', 'taxonomy.professional_network_industry', 'taxonomy.professional_network_industries',
        'locations.country', 'locations.headquarters', GROWTH_DATE, 'headcount.total', MONTH_GROWTH, 'funding'],
      sorts: [{ field: FUNDRAISE_DATE, order: 'desc' }, { field: 'crustdata_company_id', order: 'asc' }],
      limit: GROWTH_LIMIT,
    };
  },
  parse(raw, { intent }, meta) {
    const batch = emptyBatch();
    for (const row of validate(searchResponse, raw).companies) {
      if (!matchesGeography(row.locations?.country, intent.geography)) continue;
      const normalized = toCompany(row, { ...meta, asOf: intent.asOf }, 'company_growth', intent.runKind === 'replay');
      if (!normalized) continue;
      batch.mentions.push(normalized.mention);
      batch.evidence.push(...normalized.evidence);
      batch.triggers.push(...companySignals(normalized, intent));
    }
    return batch;
  },
  estimateCredits: raw => estimate(raw, 'companies', GROWTH_LIMIT, GROWTH_RATE),
};

const enrichFields = ['basic_info', 'taxonomy', 'locations', 'headcount', 'funding', 'competitors'];

export const companyEnrich: EndpointSpec<{ companies: CompanyInput[] }, Pick<TriggerBatch, 'mentions' | 'evidence' | 'triggers'>> = {
  name: 'company_enrich', path: '/company/enrich', method: 'POST',
  build({ companies }) {
    const ids = companies.map(company => companyNumber(company.crustdataId));
    const domains = companies.map(company => normalizeDomain(company.domain));
    if (ids.length && ids.every(id => id !== null)) return { crustdata_company_ids: [...new Set(ids)], fields: enrichFields };
    if (domains.length && domains.every(domain => domain !== null)) return { domains: [...new Set(domains)], exact_match: true, fields: enrichFields };
    return { names: [...new Set(companies.map(company => company.name))], fields: enrichFields };
  },
  parse(raw, { companies }, meta) {
    const { people: _people, ...batch } = emptyBatch();
    const historical = Boolean(isoDay(meta.retrievedAt) && meta.asOf < isoDay(meta.retrievedAt)!);
    const seen = new Set<string>();
    for (const result of validate(enrichResponse, raw)) {
      const matching = result.matches.filter(candidate => {
        const basic = candidate.company_data.basic_info;
        const identity = {
          name: basic?.name || '', domain: basic?.primary_domain || basic?.website,
          crustdataId: candidate.company_data.crustdata_company_id ?? basic?.crustdata_company_id,
        };
        return companies.some(company => sameCompany(identity, company));
      }).sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));
      const match = matching[0];
      if (!match) continue;
      const row = toCompany(match.company_data, meta, 'company_enrich', historical);
      if (!row || seen.has(row.recordId)) continue;
      seen.add(row.recordId);
      const identities = new Set(matching.map(candidate => candidate.company_data.crustdata_company_id ??
        candidate.company_data.basic_info?.crustdata_company_id ?? candidate.company_data.basic_info?.primary_domain));
      if (identities.size > 1) row.mention.ambiguousIdentity = true;
      batch.mentions.push(row.mention);
      batch.evidence.push(...row.evidence);
      batch.triggers.push(...companySignals(row, meta));
    }
    return batch;
  },
  estimateCredits(raw, input) {
    if (!Array.isArray(raw)) return 2 * input.companies.length;
    return 2 * raw.reduce((count, row: unknown) => {
      const matches = row && typeof row === 'object' && 'matches' in row ? row.matches : null;
      return count + (Array.isArray(matches) && matches.length > 0 ? 1 : 0);
    }, 0);
  },
};
