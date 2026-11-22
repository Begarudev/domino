// The engine's single doorway to the data layer: real Crustdata endpoint modules + domain logic.
import type { Company, Intent, Trigger } from '../../shared/types.ts';
import { outcomeCheck, outcomeHireCheck } from '../crustdata/index.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import type { CompanyMention, TriggerBatch } from '../domain/types.ts';

export {
  parseIntentRules, resolveEntities, buildCascade, rankTargets, pickDecider, findWarmPath,
  buildClaims, templateDraft, draftFrame, llmDraftPrompt, verifyDraft, filterAsOf, scoreReplay,
} from '../domain/index.ts';
export {
  jobSearch, jobSearchDisplacement, personSearchRecentMoves, companySearchGrowth, companyEnrich, personSearchDeciders, fixtureFor,
} from '../crustdata/index.ts';

// The engine's replay step reads outcome legs as trigger batches keyed by canonical company id;
// the data layer's outcome specs return OutcomeFacts keyed by `key`. Adapt one to the other here.
type OutcomeInput = { intent: Intent; companies: Company[] };
type DataOutcomeSpec = typeof outcomeHireCheck;

function keyed(input: OutcomeInput) {
  return { intent: input.intent, companies: input.companies.map(company => ({ ...company, key: company.id })) };
}

function asBatch(spec: DataOutcomeSpec): EndpointSpec<OutcomeInput, TriggerBatch> {
  return {
    name: spec.name,
    path: spec.path,
    method: spec.method,
    build: input => spec.build(keyed(input) as Parameters<DataOutcomeSpec['build']>[0]),
    parse(raw, input, meta) {
      const result = spec.parse(raw, keyed(input) as Parameters<DataOutcomeSpec['parse']>[1], meta);
      const mentions: CompanyMention[] = input.companies.map(company => ({
        key: company.id, name: company.name, domain: company.domain ?? null, linkedinUrl: company.linkedinUrl ?? null,
        crustdataId: company.crustdataId ?? null, evidenceIds: [],
      }));
      const triggers: Trigger[] = result.outcomes.map((fact, index) => ({
        id: `tr_outcome_${spec.path.replace(/\W/g, '')}_${index}`,
        companyId: fact.companyKey, kind: fact.kind, date: fact.date, summary: fact.summary, evidenceIds: fact.evidenceIds,
      }));
      return { mentions, people: [], triggers, evidence: result.evidence };
    },
    estimateCredits: (raw, input) => spec.estimateCredits(raw, keyed(input) as Parameters<DataOutcomeSpec['estimateCredits']>[1]),
  };
}

export const jobSearchOutcomes = asBatch(outcomeCheck as unknown as DataOutcomeSpec);
export const personSearchOutcomes = asBatch(outcomeHireCheck);
