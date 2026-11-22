// Fictional fixtures for exercising the runtime before the data modules land.
import { z } from 'zod';
import type {
  CascadeGraph, Company, Decider, Draft, Evidence, GraphEdge, Intent, IsoDate, Person, ReplayScore, Target, Trigger, WarmPath,
} from '../../shared/types.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import type { Claim, CompanyMention, OutcomeFact, ParseMeta, PersonMention, SellerProfile, TriggerBatch } from '../domain/types.ts';
import { NonsenseError } from '../domain/types.ts';

const aiTitles = ['CTO', 'VP Engineering', 'Head of ML Platform'];
const signals = ['inference', 'ML infrastructure', 'GPU', 'LLM serving'];
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

export function parseIntentRules(text: string, today: IsoDate): Intent {
  const replay = /\breplay\b/i.test(text);
  const dates = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).filter(date => {
    const parsed = Date.parse(date);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
  });
  const asOf = replay ? dates[0] ?? '2026-09-01' : today;
  const offering = text.match(/\b(?:we|I) sell\s+([^.!?\n;]+)/i)?.[1]?.split(/,?\s+(?:and (?:find|book)|to [^,]+|find .*)$/i)[0].trim() || null;
  const window = text.match(/\blast\s+(\d+)\s+days\b/i);
  const count = text.match(/\b(?:top|find)\s+(\d+)\s+(?:targets|companies|accounts)\b/i);
  return {
    offering, buyerProfile: 'AI companies', geography: text.match(/\bin (India|US|Europe)\b/i)?.[1] ?? null,
    windowDays: window ? Math.min(365, Math.max(1, Number(window[1]))) : 30, asOf,
    deciderTitles: aiTitles, signalKeywords: signals, maxTargets: count ? Math.min(20, Math.max(1, Number(count[1]))) : 5,
    parsedBy: 'rules', runKind: replay ? 'replay' : 'live',
    horizonEnd: replay ? (dates[1] && dates[1] > asOf ? dates[1] : shiftDays(asOf, 60)) : null,
    assumptions: ['Buyer profile defaults to AI companies', 'Decision-maker titles default to technical leadership',
      ...(!window ? ['Trigger window defaults to 30 days'] : []), ...(!count ? ['Target limit defaults to 5'] : [])],
  };
}

const companies = [
  { key: 'ember', name: 'Ember Quill', domain: 'ember-quill.invalid' },
  { key: 'lattice', name: 'Lattice Finch', domain: 'lattice-finch.invalid' },
  { key: 'silver', name: 'Silver Canopy', domain: 'silver-canopy.invalid' },
] as const;
const [ember, lattice, silver] = companies;
type FixtureCompany = (typeof companies)[number];
type CompanyInput = { name: string; domain?: string | null; crustdataId?: number | string | null };
type Search = { intent: Intent; companies?: CompanyInput[] };
type Enrich = { companies: CompanyInput[] };
type DeciderSearch = { intent: Intent; company: Company };
type OutcomeSearch = { intent: Intent; companies: (CompanyInput & { key: string })[] };
const companySchema = z.object({ key: z.string(), name: z.string(), domain: z.string() });
const rowSchema = z.object({
  id: z.string(), company: companySchema, related: companySchema.optional(), date: z.string(),
  kind: z.enum(['job_post', 'hire', 'headcount_jump', 'profile', 'decider']),
  claim: z.string(), pct: z.number().optional(), name: z.string().optional(),
});
type FixtureRow = z.infer<typeof rowSchema>;

function endpoint<I>(name: string, path: string, part: string, estimate: number): EndpointSpec<I, TriggerBatch> {
  return {
    name, path, method: 'POST', build: input => ({ fixturePart: part, ...input }),
    parse(raw, _input, meta) {
      const parsed = z.object({ rows: z.array(rowSchema) }).safeParse(raw);
      if (!parsed.success) throw new NonsenseError('Expected fixture rows');
      return normalize(parsed.data.rows, meta);
    },
    estimateCredits: raw => {
      const parsed = z.object({ rows: z.array(z.unknown()) }).safeParse(raw);
      return parsed.success && estimate < 1 ? parsed.data.rows.length * estimate : estimate;
    },
  };
}

export const jobSearch = endpoint<Search>('job_search', '/job/search', 'jobs', 0.03);
export const personSearchRecentMoves = endpoint<Search>('person_recent_moves', '/person/search', 'moves', 0.03);
export const companySearchGrowth = endpoint<{ intent: Intent }>('company_growth', '/company/search', 'growth', 0.03);
export const companyEnrich = endpoint<Enrich>('company_enrich', '/company/enrich', 'enrich', 2);
export const personSearchDeciders = endpoint<DeciderSearch>('person_deciders', '/person/search', 'deciders', 0.03);
export const jobSearchOutcomes = endpoint<OutcomeSearch>('outcome_check', '/job/search', 'outcome_jobs', 0.03);
export const personSearchOutcomes = endpoint<OutcomeSearch>('outcome_check', '/person/search', 'outcome_hires', 0.03);

export function fixtureFor(_path: string, body: unknown): unknown {
  const input = body as Search & Enrich & DeciderSearch & { fixturePart: string };
  const date = input.intent ? shiftDays(input.intent.asOf, -Math.min(5, input.intent.windowDays - 1)) : '2026-08-05';
  const row = (company: FixtureCompany, id: string, kind: FixtureRow['kind'], claim: string): FixtureRow =>
    ({ company, id, date, kind, claim });
  switch (input.fixturePart) {
    case 'jobs':
      return { rows: [row(lattice, `lattice-job-${date}`, 'job_post', `${lattice.name} posted an inference engineering role`)] };
    case 'outcome_jobs': {
      const day = shiftDays(input.intent.asOf, 12);
      return { rows: [lattice, ember].filter(company => input.companies.some(wanted => wanted.domain === company.domain)
        && day <= input.intent.horizonEnd!).map(company => ({
        ...row(company, `${company.key}-job-${day}`, 'job_post', `${company.name} posted an inference engineering role`), date: day,
      })) };
    }
    case 'outcome_hires':
      return { rows: [] };
    case 'moves':
      return { rows: input.companies ? [] : [1, 2].map(n => ({
        ...row(lattice, `move-${n}-${date}`, 'hire', `Inference engineering move from ${ember.name} to ${lattice.name}`),
        related: ember, name: `Fixture Engineer ${n}`,
      })) };
    case 'growth':
      return { rows: [{ ...row(silver, `growth-${date}`, 'headcount_jump', `${silver.name} grew its headcount by 35%`), pct: 35 }] };
    case 'enrich':
      return { rows: companies.filter(company => input.companies.some(wanted => wanted.domain === company.domain)).map(company =>
        row(company, `profile-${company.key}`, 'profile', `Company profile for ${company.name}`)) };
    case 'deciders': {
      const company = companies.find(item => item.domain === input.company.domain);
      return { rows: company ? [{ ...row(company, `decider-${company.key}`, 'decider', `CTO at ${company.name}`),
        name: ({ ember: 'Ari Flint', lattice: 'Kit Alder', silver: 'Sol Reed' })[company.key] }] : [] };
    }
    default:
      return { rows: [] };
  }
}

function normalize(rows: FixtureRow[], meta: ParseMeta): TriggerBatch {
  const batch: TriggerBatch = { mentions: [], people: [], triggers: [], evidence: [] };
  for (const row of rows) {
    const id = `ev_fixture_${row.id}`;
    batch.evidence.push({
      id, claim: row.claim, source: { provider: 'crustdata', endpoint: meta.endpoint, recordId: row.id, field: row.kind },
      observedAt: row.date, retrievedAt: meta.retrievedAt, mode: 'fixture', verifiable: true,
      ...(row.pct ? { value: row.pct } : {}),
    });
    const mention = (company: FixtureRow['company']): CompanyMention => ({
      ...company, key: `${row.id}:${company.key}`, evidenceIds: [id],
      ...(row.pct ? { headcountGrowthPct: { window: '1m', pct: row.pct } as const } : {}),
    });
    const company = mention(row.company);
    const related = row.related && mention(row.related);
    batch.mentions.push(company);
    if (related) batch.mentions.push(related);
    const personId = row.name && `pe_${row.id}`;
    if (personId && row.name) batch.people.push({
      key: personId, name: row.name, title: row.kind === 'decider' ? 'CTO' : 'Inference Engineer',
      companyKey: company.key, startedAt: row.date, evidenceIds: [id],
      pastEmployers: related ? [{ name: related.name, companyId: related.key, to: row.date }] : [],
    });
    if (row.kind === 'headcount_jump' || row.kind === 'job_post' || row.kind === 'hire') batch.triggers.push({
      id: `tr_${row.id}`, companyId: company.key, relatedCompanyId: related?.key, personId,
      kind: row.kind, date: row.date, summary: row.claim, evidenceIds: [id],
    });
  }
  return batch;
}

export function resolveEntities(mentions: CompanyMention[], people: PersonMention[]) {
  const byId = new Map<string, Company>();
  const idMap: Record<string, string> = {};
  for (const mention of mentions) {
    const id = `co_${(mention.domain ?? mention.name).split('.')[0].toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')}`;
    idMap[mention.key] = id;
    const existing = byId.get(id);
    if (existing) {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...mention.evidenceIds])];
      if (mention.headcountGrowthPct) existing.headcountGrowthPct = mention.headcountGrowthPct;
    } else {
      byId.set(id, { id, name: mention.name, aliases: [mention.name], domain: mention.domain,
        headcountGrowthPct: mention.headcountGrowthPct, evidenceIds: [...mention.evidenceIds] });
    }
  }
  const resolvedPeople = people.map((person): Person => {
    idMap[person.key] = person.key;
    return { id: person.key, name: person.name, title: person.title, companyId: idMap[person.companyKey ?? ''] ?? null,
      startedAt: person.startedAt, evidenceIds: person.evidenceIds, pastEmployers: person.pastEmployers.map(employer =>
        ({ ...employer, companyId: idMap[employer.companyId ?? ''] ?? null })) };
  });
  return { companies: [...byId.values()], people: resolvedPeople, merges: [], keptApart: [], idMap };
}

export function buildCascade(intent: Intent, triggers: Trigger[], entities: Company[], evidence: Evidence[]): CascadeGraph {
  const edges: GraphEdge[] = [];
  const supports = new Set(evidence.filter(row => row.verifiable && row.observedAt).map(row => row.id));
  const hires = triggers.filter(trigger => trigger.kind === 'hire' && trigger.relatedCompanyId);
  for (const hire of hires) {
    if (edges.some(edge => edge.from === hire.companyId && edge.to === hire.relatedCompanyId)) continue;
    const group = hires.filter(other => other.companyId === hire.companyId && other.relatedCompanyId === hire.relatedCompanyId);
    const evidenceIds = [...new Set(group.flatMap(item => item.evidenceIds).filter(id => supports.has(id)))];
    if (group.length < 2 || evidenceIds.length < 2) continue;
    edges.push({
      id: `ed_${hire.companyId}_${hire.relatedCompanyId}`, from: hire.companyId, to: hire.relatedCompanyId!,
      mechanism: 'TALENT_DRAIN', label: `${group.length} inference engineering moves`,
      rationale: 'Recent engineering moves suggest that the former employer may need additional inference capacity.',
      confidence: 0.82, observedAt: group.map(item => item.date).sort().at(-1)!, evidenceIds, order: edges.length,
    });
  }
  const nodes = entities.map(company => {
    const edge = edges.find(edge => edge.to === company.id);
    const own = triggers.filter(trigger => trigger.companyId === company.id);
    const hiring = own.some(trigger => trigger.kind === 'job_post');
    return {
      id: company.id, name: company.name, tier: edge ? 1 : 0, need: edge || hiring ? intent.offering : null,
      confidence: edge?.confidence ?? (hiring ? 0.65 : null),
      mechanisms: edge ? [edge.mechanism] : hiring ? ['DIRECT' as const] : [], netNew: Boolean(edge && !hiring),
      triggerIds: own.map(trigger => trigger.id), evidenceIds: edge?.evidenceIds ?? own.flatMap(trigger => trigger.evidenceIds),
      status: 'hypothesis' as const,
    };
  });
  return { nodes, edges };
}

export function rankTargets(intent: Intent, graph: CascadeGraph, _companies: Company[], triggers: Trigger[]) {
  const hiringFilterCompanyIds = [...new Set(triggers.filter(trigger => trigger.kind === 'job_post').map(trigger => trigger.companyId))];
  const targets: Target[] = graph.nodes.filter(node => node.need && node.confidence !== null)
    .sort((a, b) => b.confidence! - a.confidence!).slice(0, intent.maxTargets).map((node, index) => {
      const edge = graph.edges.find(edge => edge.to === node.id);
      const job = triggers.find(trigger => trigger.companyId === node.id && trigger.kind === 'job_post');
      return {
        companyId: node.id, rank: index + 1, score: node.confidence!, confidence: node.confidence!, need: node.need!,
        mechanisms: node.mechanisms, netNew: node.netNew, whyNow: edge?.label ?? job?.summary ?? 'Recent activity',
        whyNowDate: edge?.observedAt ?? job?.date ?? null, decider: null, path: null, draftId: null,
      };
    });
  return { targets, baseline: { hiringFilterCompanyIds } };
}

export function pickDecider(_intent: Intent, company: Company, candidates: Person[]): Decider | null {
  const person = candidates.find(person => person.companyId === company.id);
  return person ? { personId: person.id, name: person.name, title: person.title, tenureSince: person.startedAt,
    reason: 'The CTO leads technical infrastructure decisions.', evidenceIds: person.evidenceIds } : null;
}

export function findWarmPath(decider: Decider, _person: Person, _company: Company, _seller: SellerProfile,
  _triggers: Trigger[], _companies: Company[]): WarmPath | null {
  return { strength: 'cold', score: 0, hops: [{ label: decider.name, kind: 'decider' }],
    explanation: 'No shared employer or customer link in the fixture.', evidenceIds: [] };
}

export function buildClaims(target: Target, company: Company, triggers: Trigger[], evidence: Evidence[], graph: CascadeGraph): Claim[] {
  const edge = graph.edges.find(item => item.to === company.id);
  const job = triggers.find(item => item.companyId === company.id && item.kind === 'job_post');
  const evidenceIds = edge?.evidenceIds ?? job?.evidenceIds ?? [];
  const from = graph.nodes.find(node => node.id === edge?.from);
  const text = edge && from ? `${edge.evidenceIds.length} inference engineers moved from ${company.name} to ${from.name}` :
    job?.summary ?? `${company.name} showed interest in ${target.need}`;
  return [{
    n: 1, text, evidenceIds,
    verifiable: evidenceIds.length > 0 && evidenceIds.every(id => evidence.some(row => row.id === id && row.observedAt && row.verifiable)),
    numbers: text.match(/\d+/g) ?? [],
  }];
}

export function templateDraft(target: Target, decider: Decider | null, claims: Claim[], seller: SellerProfile): Draft {
  const lines = claims.filter(claim => claim.verifiable).map(claim => `${claim.text} [${claim.n}].`);
  return {
    id: `dr_${target.companyId}`, companyId: target.companyId, personId: decider?.personId ?? null,
    subject: 'Inference capacity', body: [`Hi ${decider?.name.split(' ')[0] ?? 'there'}!`, ...lines, 'Open to a quick call?'].join('\n'),
    citations: [], unverifiable: [], checks: [], verified: false, generator: 'template',
    meeting: { title: seller.meeting.title, durationMin: seller.meeting.durationMin, proposedSlots: seller.meeting.slots },
  };
}

export function llmDraftPrompt(_target: Target, decider: Decider | null, claims: Claim[], _seller: SellerProfile) {
  return {
    system: 'Write a brief outreach draft as JSON {subject, body}. Only use supplied facts. Copy factual sentences and cite their numbered claims using [n].',
    user: JSON.stringify({ recipient: decider?.name, claims: claims.filter(item => item.verifiable).map(({ n, text }) => ({ n, text })) }),
  };
}

export function verifyDraft(draft: { subject: string; body: string }, claims: Claim[], evidence: Evidence[]): Pick<Draft,
  'body' | 'citations' | 'checks' | 'unverifiable' | 'verified'> {
  const checks: Draft['checks'] = [];
  const citations: Draft['citations'] = [];
  const unverifiable: Draft['unverifiable'] = claims.filter(claim => !claim.verifiable)
    .map(claim => ({ claim: claim.text, reason: claim.reason ?? 'Missing dated evidence' }));
  const body = draft.body.split(/\n+|(?<=[.!?])\s+/).flatMap(line => {
    const sentence = line.trim();
    if (!sentence) return [];
    const match = claims.find(claim => sentence.replace(/[.!?]$/, '') === `${claim.text} [${claim.n}]`);
    if (match?.verifiable && match.evidenceIds.length && match.evidenceIds.every(id =>
      evidence.some(row => row.id === id && row.verifiable && row.observedAt))) {
      checks.push({ sentence, status: 'cited', evidenceIds: match.evidenceIds });
      citations.push(...match.evidenceIds.map(evidenceId => ({ marker: match.n, evidenceId })));
      return [sentence];
    }
    if (/^Hi [\p{L}\p{M}' -]+!$/u.test(sentence) || sentence === 'Open to a quick call?') {
      checks.push({ sentence, status: 'no_claim', evidenceIds: [] });
      return [sentence];
    }
    checks.push({ sentence, status: 'removed', evidenceIds: [], note: 'No matching dated claim' });
    unverifiable.push({ claim: sentence, reason: 'No matching dated claim' });
    return [];
  }).join('\n');
  return { body, citations, checks, unverifiable, verified: Boolean(body) };
}

export function filterAsOf(evidence: Evidence[], asOf: IsoDate) {
  const kept = evidence.filter(row => row.observedAt && row.observedAt <= asOf);
  return { kept, dropped: evidence.length - kept.length };
}

export function scoreReplay(intent: Intent, targets: Target[], baseline: { firstOrder: string[]; headcount: string[] },
  outcomes: OutcomeFact[]): ReplayScore {
  const domino = targets.map(target => target.companyId);
  const firstSeen = (id: string) => outcomes.filter(item => item.companyKey === id && item.date > intent.asOf
    && item.date <= intent.horizonEnd!).sort((a, b) => a.date.localeCompare(b.date))[0];
  const metrics = (ids: string[]) => {
    const lead = ids.flatMap(id => {
      const fact = firstSeen(id);
      return fact ? [(Date.parse(fact.date) - Date.parse(intent.asOf)) / 86_400_000] : [];
    }).sort((a, b) => a - b);
    const middle = Math.floor(lead.length / 2);
    return { predicted: ids.length, hits: lead.length, precision: ids.length ? lead.length / ids.length : 0,
      medianLeadDays: lead.length ? (lead[middle] + lead[Math.floor((lead.length - 1) / 2)]) / 2 : null };
  };
  return {
    asOf: intent.asOf, horizonEnd: intent.horizonEnd!, factsAfterAsOfUsed: 0, domino: metrics(domino),
    baselineFirstOrder: metrics(baseline.firstOrder), baselineHeadcount: metrics(baseline.headcount),
    outcomes: [...new Set([...domino, ...baseline.firstOrder, ...baseline.headcount])].map(companyId => {
      const fact = firstSeen(companyId);
      return {
        companyId, predictedBy: domino.includes(companyId) ? baseline.firstOrder.includes(companyId) || baseline.headcount.includes(companyId)
          ? 'both' : 'domino' : baseline.firstOrder.includes(companyId) ? 'baseline_first_order' : 'baseline_headcount',
        hit: Boolean(fact), outcomeDate: fact?.date ?? null, outcome: fact?.summary ?? 'No dated sign observed',
        evidenceIds: fact?.evidenceIds ?? [],
      };
    }),
    note: 'Fictional fixture replay. Precision is reported for all three prediction sets.',
  };
}
