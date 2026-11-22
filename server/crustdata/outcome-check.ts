import type { Intent } from '../../shared/types.ts';
import { servingSignalKeywords } from '../domain/facts.ts';
import type { OutcomeFact, TriggerBatch } from '../domain/types.ts';
import { companyFilter, estimate, mentionFor, sameCompany } from './common.ts';
import type { CompanyInput } from './common.ts';
import { buildJobs, jobCompanyFields, JOB_LIMIT, parseJobs } from './job-search.ts';
import { buildPeopleMoves, MOVES_LIMIT, parsePeopleMoves } from './person-search.ts';
import type { EndpointSpec } from './spec.ts';

type Input = { intent: Intent; companies: (CompanyInput & { key: string })[] };
type Output = { outcomes: OutcomeFact[]; evidence: TriggerBatch['evidence'] };

const outcomeIntent = (intent: Intent): Intent => ({
  ...intent, signalKeywords: [...new Set([...intent.signalKeywords, ...servingSignalKeywords])],
});

function extract(batch: TriggerBatch, companies: Input['companies'], kind: OutcomeFact['kind']): Output {
  const outcomes: OutcomeFact[] = [];
  for (const trigger of batch.triggers) {
    if (trigger.kind !== kind) continue;
    const employer = mentionFor(batch, trigger.companyId);
    if (!employer) continue;
    const company = companies.find(item => sameCompany(item, employer));
    const title = batch.evidence.find(row => trigger.evidenceIds.includes(row.id) &&
      (kind === 'job_post' ? row.source.field === '$.job_details.title' : row.source.field?.endsWith('.start_date')))?.value;
    if (company) outcomes.push({
      companyKey: company.key, kind, title: typeof title === 'string' ? title : undefined, date: trigger.date, summary: trigger.summary, evidenceIds: trigger.evidenceIds,
    });
  }
  const used = new Set(outcomes.flatMap(fact => fact.evidenceIds));
  return { outcomes, evidence: batch.evidence.filter(row => used.has(row.id)) };
}

export const outcomeHireCheck: EndpointSpec<Input, Output> = {
  name: 'outcome_check', path: '/person/search', method: 'POST',
  build({ intent, companies }) {
    return buildPeopleMoves(intent, intent.asOf, intent.horizonEnd ?? intent.asOf, companies);
  },
  parse(raw, { intent, companies }, meta) {
    return extract(parsePeopleMoves(raw, intent, meta, intent.asOf, intent.horizonEnd ?? intent.asOf, companies), companies, 'hire');
  },
  estimateCredits: raw => estimate(raw, 'profiles', MOVES_LIMIT, 0.23),
};

// Indexed job and person search are separate requests. Both legs use the same logical endpoint name.
export const outcomeCheck: EndpointSpec<Input, Output> & { hires: typeof outcomeHireCheck } = {
  name: 'outcome_check', path: '/job/search', method: 'POST',
  build({ intent, companies }) {
    return buildJobs(outcomeIntent(intent), intent.asOf, intent.horizonEnd ?? intent.asOf, companyFilter(companies, jobCompanyFields));
  },
  parse(raw, { intent, companies }, meta) {
    return extract(parseJobs(raw, outcomeIntent(intent), meta, intent.asOf, intent.horizonEnd ?? intent.asOf, { allowAnyGeography: true }), companies, 'job_post');
  },
  estimateCredits: raw => estimate(raw, 'job_listings', JOB_LIMIT, 0.03),
  hires: outcomeHireCheck,
};
