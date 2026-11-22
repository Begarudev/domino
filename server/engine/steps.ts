import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  Approval, Ask, CascadeGraph, Company, Draft, Evidence, Intent, Person, ReplayScore, RunEvent, StepName, Target, Trigger,
} from '../../shared/types.ts';
import { now } from '../db.ts';
import type { OutcomeFact, SellerProfile, TriggerBatch } from '../domain/types.ts';
import { root } from '../env.ts';
import { modelClient } from '../llm/client.ts';
import { mapLimit } from '../runtime/pool.ts';
import { hash, ToolContext } from '../runtime/tool.ts';
import * as deps from './deps.ts';
import { dateShift, predictionEvidence, publishSource, readSource } from './sources.ts';
import { candidateSteps } from './candidate-steps.ts';
import type { CandidateOutputs } from './candidate-steps.ts';
import { openingsSteps } from './openings-steps.ts';
import type { OpeningsOutputs } from './openings-steps.ts';

const sellerFile = resolve(root, 'config/seller.json');
const seller: SellerProfile = existsSync(sellerFile) ? JSON.parse(readFileSync(sellerFile, 'utf8')) : {
  company: 'Cirrus Kiln', offering: 'managed GPU inference', oneLiner: 'We help teams scale inference workloads.',
  senderName: 'Ira', team: [], customers: [], meeting: { title: 'Managed inference discussion', durationMin: 20, slots: [] },
  displacementEvents: [],
};

type Resolved = ReturnType<typeof deps.resolveEntities> & { triggers: Trigger[]; evidence: Evidence[] };
type Ranked = ReturnType<typeof deps.rankTargets>;
type Deciders = { targets: Target[]; people: Person[]; evidence: Evidence[] };
type Drafted = { targets: Target[]; drafts: Draft[] };
export interface Outputs extends OpeningsOutputs, CandidateOutputs {
  parse_request: Intent;
  pull_triggers: TriggerBatch;
  resolve_entities: Resolved;
  enrich_companies: Resolved;
  cascade: CascadeGraph;
  rank_targets: Ranked;
  find_deciders: Deciders;
  warm_paths: Target[];
  draft_messages: Drafted;
  approval_gate: Approval[];
  score_replay: ReplayScore;
}

export type Checkpoints = Partial<Outputs>;
export type StepResult<K extends StepName> = { output: Outputs[K]; summary: string; events?: RunEvent[] };
export type Runner<K extends StepName> = (ctx: ToolContext, checkpoints: Checkpoints) => Promise<StepResult<K>> | StepResult<K>;
const unique = <T>(items: T[]) => [...new Set(items)];
const byId = <T extends { id: string }>(rows: T[]) => [...new Map(rows.map(row => [row.id, row])).values()];
function publishTriggers(ctx: ToolContext, triggers: Trigger[]) {
  const seen = ctx.store.sql.prepare(`SELECT 1 FROM events WHERE run_id = ? AND type = 'trigger.found'
    AND json_extract(payload_json, '$.trigger.id') = ? LIMIT 1`);
  for (const trigger of triggers) {
    if (!seen.get(ctx.runId, trigger.id)) ctx.store.recordEvent(ctx.runId, { type: 'trigger.found', trigger });
  }
}
const emptyBatch = (): TriggerBatch => ({ mentions: [], people: [], triggers: [], evidence: [] });

const refinements = z.object({
  buyerProfile: z.string().trim().min(1).max(150).optional(),
  geography: z.string().trim().min(1).max(100).nullable().optional(),
  deciderTitles: z.array(z.string().trim().min(1).max(100)).min(1).max(12).optional(),
  signalKeywords: z.array(z.string().trim().min(1).max(100)).min(1).max(16).optional(),
});

export function refineIntent(intent: Intent, request: string, modelResult: unknown): Intent {
  const parsed = refinements.safeParse(modelResult);
  if (!parsed.success) return intent;
  const { buyerProfile, geography, deciderTitles, signalKeywords } = parsed.data;
  const candidateGeography = geography && !/^(?:anywhere|global(?:ly)?|worldwide|all|none|any)$/i.test(geography)
    && request.toLowerCase().includes(geography.toLowerCase()) ? geography : null;
  const appendTerms = (current: string[], extra: string[] = [], max: number) => {
    const combined = new Map(current.map(value => [value.toLowerCase(), value]));
    for (const value of extra) if (!combined.has(value.toLowerCase())) combined.set(value.toLowerCase(), value);
    return [...combined.values()].slice(0, max);
  };
  const updated: Intent = {
    ...intent,
    buyerProfile: buyerProfile ?? intent.buyerProfile,
    geography: intent.geography ?? candidateGeography,
    deciderTitles: appendTerms(intent.deciderTitles, deciderTitles, 12),
    signalKeywords: appendTerms(intent.signalKeywords, signalKeywords, 16),
  };
  if (JSON.stringify(updated) === JSON.stringify(intent)) return intent;
  updated.assumptions = intent.assumptions.filter(item =>
    !(updated.buyerProfile !== intent.buyerProfile && /buyer profile/i.test(item)) &&
    !(updated.geography !== intent.geography && /geography/i.test(item)));
  return { ...updated, parsedBy: 'llm' };
}

async function parseRequest(ctx: ToolContext): Promise<StepResult<'parse_request'>> {
  const run = ctx.store.requireRun(ctx.runId);
  const today = run.created_at.slice(0, 10);
  const rules = deps.parseIntentRules(run.request, today);
  const askId = `ask_${ctx.runId}_offering`;
  let answer = ctx.store.getAsk(ctx.runId, askId)?.answer;
  if (!rules.offering && !answer) {
    ctx.store.transaction(() => {
      if (!ctx.store.getAsk(ctx.runId, askId)) {
        const ask: Ask = {
          id: askId, question: 'What do you sell? The cascade rules depend on it.',
          why: 'Your offering determines which changes predict a need.', options: [seller.offering], default: seller.offering,
        };
        ctx.store.recordEvent(ctx.runId, { type: 'ask.requested', ask });
      }
      ctx.store.recordEvent(ctx.runId, { type: 'run.status', status: 'awaiting_input' });
    });
    while (!answer) {
      await ctx.wait(500);
      ctx.assertTime();
      answer = ctx.store.getAsk(ctx.runId, askId)?.answer;
    }
  }
  if (ctx.store.requireRun(ctx.runId).status === 'awaiting_input') {
    ctx.store.appendEvent(ctx.runId, { type: 'run.status', status: 'running' });
  }
  const amended = !rules.offering && answer ? deps.parseIntentRules(`We sell ${answer}. ${run.request}`, today) : rules;
  const intent = { ...amended, offering: rules.offering ?? answer ?? seller.offering };
  const completion = await modelClient(ctx).complete({
    purpose: 'parse', json: true, maxTokens: 2000,
    system: 'Refine an outbound search intent from the request and confirmed offering. Return only buyerProfile, geography, deciderTitles and signalKeywords. Omit any field you cannot infer.',
    user: JSON.stringify({ request: run.request, offering: intent.offering, rules: intent }),
  });
  if (completion) Object.assign(intent, refineIntent(intent, run.request, JSON.parse(completion.text)));
  return { output: intent, summary: `${intent.runKind === 'replay' ? 'Replay' : 'Run'} for ${intent.offering}` };
}

function guardBatch(batch: TriggerBatch, intent: Intent): TriggerBatch {
  const evidence = predictionEvidence(batch.evidence, intent);
  const byEvidence = new Map(evidence.map(row => [row.id, row]));
  const replay = intent.runKind === 'replay';
  const ids = (row: { evidenceIds: string[] }) => row.evidenceIds.filter(id => byEvidence.has(id));
  const mentions = batch.mentions.flatMap(mention => {
    const evidenceIds = ids(mention);
    if (replay && !evidenceIds.length) return [];
    if (!replay) return [{ ...mention, evidenceIds }];
    const supports = (pattern: RegExp) => evidenceIds.some(id => pattern.test(byEvidence.get(id)?.source.field ?? ''));
    return [{
      ...mention, evidenceIds,
      headcount: supports(/headcount|employee_count/i) ? mention.headcount : undefined,
      headcountGrowthPct: supports(/growth|headcount|employee_count/i) ? mention.headcountGrowthPct : undefined,
      lastFunding: mention.lastFunding?.date && mention.lastFunding.date <= intent.asOf && supports(/funding/i)
        ? mention.lastFunding : undefined,
      industry: supports(/taxonomy|industry|categories/i) ? mention.industry : undefined,
      hq: supports(/locations|headquarters/i) ? mention.hq : undefined,
      foundedYear: supports(/founded/i) ? mention.foundedYear : undefined,
      acquisitions: mention.acquisitions?.filter(acquisition => acquisition.date && acquisition.date <= intent.asOf),
      ...(supports(/competitor|peer/i) ? {} : { competitorNames: undefined, competitorDomains: undefined }),
    }];
  });
  const people = batch.people.flatMap(person => {
    const evidenceIds = ids(person);
    if (replay && (!evidenceIds.length || !person.startedAt || person.startedAt > intent.asOf)) return [];
    return [{
      ...person, evidenceIds,
      pastEmployers: replay ? person.pastEmployers.filter(role => (role.from ?? role.to) &&
        (!role.from || role.from <= intent.asOf) && (!role.to || role.to <= intent.asOf)) : person.pastEmployers,
    }];
  });
  const companyKeys = new Set(mentions.map(mention => mention.key));
  return {
    evidence, mentions, people, triggers: batch.triggers.flatMap(trigger => {
      const evidenceIds = ids(trigger);
      if (!companyKeys.has(trigger.companyId)) return [];
      if (replay && (trigger.date > intent.asOf || !evidenceIds.length || evidenceIds.length !== trigger.evidenceIds.length ||
        (trigger.relatedCompanyId && !companyKeys.has(trigger.relatedCompanyId)))) return [];
      return [{ ...trigger, evidenceIds }];
    }),
  };
}

async function pullTriggers(ctx: ToolContext, { parse_request }: Checkpoints): Promise<StepResult<'pull_triggers'>> {
  const intent = parse_request!;
  const input = { intent };
  const output = emptyBatch();
  const append = (batch: Awaited<ReturnType<typeof readSource>>) => {
    const kept = guardBatch(batch, intent);
    ctx.store.transaction(() => {
      publishSource(ctx, batch, kept.evidence, kept.triggers.flatMap(trigger => trigger.evidenceIds));
      publishTriggers(ctx, kept.triggers);
    });
    output.mentions.push(...kept.mentions);
    output.people.push(...kept.people);
    output.triggers.push(...kept.triggers);
    output.evidence.push(...kept.evidence);
  };
  append(await readSource(ctx, deps.jobSearch, input, intent));
  for await (const page of deps.readMovesPages(intent, request => readSource(ctx, deps.personSearchRecentMoves, request, intent))) {
    append(page);
  }
  append(await readSource(ctx, deps.companySearchGrowth, input, intent));
  output.evidence = byId(output.evidence);
  output.triggers = byId(output.triggers);
  return { output, summary: `${output.triggers.length} triggers from ${output.evidence.length} evidence rows` };
}

function resolveBatch(batch: TriggerBatch): Resolved {
  const result = deps.resolveEntities(batch.mentions, batch.people);
  const { idMap } = result;
  const triggers = batch.triggers.flatMap(trigger => {
    const companyId = idMap[trigger.companyId];
    if (!companyId) return [];
    return [{
      ...trigger, companyId,
      relatedCompanyId: trigger.relatedCompanyId ? idMap[trigger.relatedCompanyId] ?? null : null,
      personId: trigger.personId ? idMap[trigger.personId] ?? null : null,
    }];
  });
  return { ...result, triggers, evidence: byId(batch.evidence) };
}

function resolveEntities(_ctx: ToolContext, { pull_triggers: batch }: Checkpoints): StepResult<'resolve_entities'> {
  const output = resolveBatch(batch!);
  return {
    output, summary: `${output.companies.length} canonical companies, ${output.merges.length} merges`,
    events: [
      ...output.merges.map(merge => ({ type: 'entity.merged' as const, merge })),
      ...output.keptApart.map(decision => ({ type: 'entity.kept_apart' as const, decision })),
    ],
  };
}

async function enrichCompanies(ctx: ToolContext, c: Checkpoints): Promise<StepResult<'enrich_companies'>> {
  const resolved = c.resolve_entities!;
  const intent = c.parse_request!;
  const frequency = new Map<string, number>();
  for (const trigger of resolved.triggers) {
    for (const id of unique([trigger.companyId, trigger.relatedCompanyId])) {
      if (id) frequency.set(id, (frequency.get(id) ?? 0) + 1);
    }
  }
  const companyOrder = resolved.companies.slice().sort((a, b) => (frequency.get(b.id) ?? 0) - (frequency.get(a.id) ?? 0)
    || a.id.localeCompare(b.id));
  const companies = companyOrder.slice(0, Math.max(5, intent.maxTargets));
  if (!companies.length) return { output: resolved, summary: 'No companies to enrich' };
  const result = await readSource(ctx, deps.companyEnrich, { companies }, intent);
  const kept = guardBatch(result, intent);
  ctx.store.transaction(() => {
    publishSource(ctx, result, kept.evidence, kept.triggers.flatMap(trigger => trigger.evidenceIds));
    publishTriggers(ctx, kept.triggers);
  });
  if (!kept.mentions.length) return { output: { ...resolved, evidence: byId([...resolved.evidence, ...kept.evidence]) },
    summary: `${companies.length} companies checked for dated enrichment` };
  const raw = c.pull_triggers!;
  const output = resolveBatch({
    ...raw, mentions: [...raw.mentions, ...kept.mentions], people: [...raw.people, ...kept.people],
    evidence: [...raw.evidence, ...kept.evidence], triggers: byId([...raw.triggers, ...kept.triggers]),
  });
  return { output, summary: `Enriched ${kept.mentions.length} company records` };
}

async function cascade(ctx: ToolContext, c: Checkpoints): Promise<StepResult<'cascade'>> {
  const { companies, triggers, evidence } = c.enrich_companies!;
  const intent = c.parse_request!;
  const output = deps.buildCascade(intent, triggers, companies, predictionEvidence(evidence, intent));
  output.nodes.sort((a, b) => a.tier - b.tier);
  output.edges.sort((a, b) => a.order - b.order);
  const emit = (event: Extract<RunEvent, { type: 'graph.node' | 'graph.edge' }>) => {
    const id = event.type === 'graph.node' ? event.node.id : event.edge.id;
    const field = event.type === 'graph.node' ? '$.node.id' : '$.edge.id';
    const found = ctx.store.sql.prepare('SELECT 1 FROM events WHERE run_id = ? AND type = ? AND json_extract(payload_json, ?) = ? LIMIT 1')
      .get(ctx.runId, event.type, field, id);
    if (!found) ctx.store.appendEvent(ctx.runId, event);
  };
  for (const node of output.nodes) emit({ type: 'graph.node', node });
  for (const [index, edge] of output.edges.entries()) {
    if (index) await ctx.wait(250);
    ctx.assertTime();
    emit({ type: 'graph.edge', edge });
  }
  return { output, summary: `${output.nodes.length} companies, ${output.edges.length} cascade edges` };
}

function rankTargets(_ctx: ToolContext, c: Checkpoints): StepResult<'rank_targets'> {
  const { companies, triggers } = c.enrich_companies!;
  const output = deps.rankTargets(c.parse_request!, c.cascade!, companies, triggers);
  const events: RunEvent[] = [{ type: 'targets.ranked', ...output }];
  for (const target of output.targets) {
    if (target.hold) events.push({ type: 'target.held', companyId: target.companyId, reasons: target.hold.reasons });
  }
  return { output, summary: `${output.targets.length} ranked accounts`, events };
}

async function findDeciders(ctx: ToolContext, c: Checkpoints): Promise<StepResult<'find_deciders'>> {
  const intent = c.parse_request!;
  const { companies, people } = c.enrich_companies!;
  const output: Deciders = { targets: [], people: [...people], evidence: [] };
  for (const target of c.rank_targets!.targets) {
    if (target.hold || target.watch) {
      output.targets.push(target);
      continue;
    }
    const company = companies.find(row => row.id === target.companyId);
    if (!company) {
      output.targets.push(target);
      continue;
    }
    const result = await readSource(ctx, deps.personSearchDeciders, { intent, company }, intent);
    const kept = guardBatch(result, intent);
    const mentions = kept.people.map(person => ({ ...person, companyKey: company.id }));
    const resolved = deps.resolveEntities([{ ...company, key: company.id }], mentions);
    const candidates = resolved.people.map(person => ({
      ...person, companyId: company.id,
      pastEmployers: person.pastEmployers.map(role => ({
        ...role, companyId: companies.find(candidate => candidate.aliases.some(alias => alias.toLowerCase() === role.name.toLowerCase()))?.id ?? role.companyId,
      })),
    }));
    const decider = deps.pickDecider(intent, company, candidates);
    ctx.store.transaction(() => publishSource(ctx, result, kept.evidence, decider?.evidenceIds ?? []));
    output.people.push(...candidates);
    output.evidence.push(...kept.evidence);
    output.targets.push({ ...target, decider });
  }
  output.people = byId(output.people);
  return { output, summary: `${output.targets.filter(row => row.decider).length} decision-makers found`,
    events: output.targets.map(target => ({ type: 'decider.found', companyId: target.companyId, decider: target.decider })) };
}

function warmPaths(_ctx: ToolContext, c: Checkpoints): StepResult<'warm_paths'> {
  const { companies, triggers } = c.enrich_companies!;
  const { targets, people } = c.find_deciders!;
  const output = targets.map(target => {
    const company = companies.find(company => company.id === target.companyId);
    const person = people.find(person => person.id === target.decider?.personId);
    const path = target.decider && person && company
      ? deps.findWarmPath(target.decider, person, company, seller, triggers, companies) : null;
    return { ...target, path };
  });
  return { output, summary: `${output.filter(target => target.path?.strength === 'warm').length} warm introductions`,
    events: output.map(target => ({ type: 'path.found', companyId: target.companyId, path: target.path })) };
}

const messageShape = z.object({ subject: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(5000) });
function futureSlots(seller: SellerProfile, createdAt: string) {
  const slots = seller.meeting.slots.filter(slot => Date.parse(slot) > Date.parse(createdAt));
  if (slots.length) return slots;
  const date = dateShift(createdAt, 1);
  return [`${date}T11:00:00+05:30`, `${dateShift(date, 1)}T15:30:00+05:30`];
}

const draftConcurrency = 3;

async function draftMessages(ctx: ToolContext, c: Checkpoints): Promise<StepResult<'draft_messages'>> {
  const { companies, triggers, evidence: companyEvidence } = c.enrich_companies!;
  const evidence = predictionEvidence(byId([...companyEvidence, ...c.find_deciders!.evidence]), c.parse_request!);
  const profile = { ...seller, offering: c.parse_request!.offering ?? seller.offering,
    meeting: { ...seller.meeting, slots: futureSlots(seller, ctx.store.requireRun(ctx.runId).created_at) } };
  // Each attempt reserves its cost inside the ledger transaction before making a model request.
  const results = await mapLimit(c.warm_paths!, draftConcurrency, async target => {
    const company = companies.find(row => row.id === target.companyId);
    if (!company || target.hold || target.watch) return { target };
    const claims = deps.buildClaims(target, company, triggers, evidence, c.cascade!);
    const template = deps.templateDraft(target, target.decider, claims, profile);
    const prompt = deps.llmDraftPrompt(target, target.decider, claims.filter(claim => claim.verifiable), profile);
    const completion = await modelClient(ctx).complete({ purpose: 'draft', ...prompt, json: true, maxTokens: 3000 });
    const parsed = completion ? safeJson(completion.text, messageShape) : null;
    const checked = parsed ? deps.verifyDraft({ subject: template.subject, body: parsed.body }, claims, evidence) : null;
    let draft: Draft;
    if (checked?.verified && checked.body.trim()) {
      const frame = deps.draftFrame(target.decider, profile);
      const frameCheck = (sentence: string) => ({ sentence, status: 'no_claim' as const, evidenceIds: [] });
      draft = {
        ...template, ...checked, generator: completion!.model,
        body: [frame.greeting, checked.body.trim(), frame.cta, frame.signoff].filter(Boolean).join('\n\n'),
        checks: [frameCheck(frame.greeting), ...checked.checks, frameCheck(frame.cta), frameCheck(frame.signoff)],
      };
    } else {
      draft = { ...template, ...deps.verifyDraft(template, claims, evidence) };
    }
    const unverifiable = new Map([...draft.unverifiable, ...(checked?.unverifiable ?? [])].map(item => [item.claim, item]));
    for (const check of [...draft.checks, ...(checked?.checks ?? [])]) {
      if (check.status === 'removed' && !unverifiable.has(check.sentence)) {
        unverifiable.set(check.sentence, { claim: check.sentence, reason: check.note ?? 'Missing support in the cited evidence' });
      }
    }
    draft.unverifiable = [...unverifiable.values()];
    return { target: { ...target, draftId: draft.id }, draft };
  });
  const drafts: Draft[] = [];
  const targets: Target[] = [];
  const events: RunEvent[] = [];
  for (const { target, draft } of results) {
    targets.push(target);
    if (!draft) continue;
    drafts.push(draft);
    events.push(...draft.unverifiable.map(item => ({ type: 'claim.unverifiable' as const, companyId: target.companyId, ...item })),
      { type: 'draft.ready', draft });
  }
  return { output: { targets, drafts }, summary: `${drafts.length} drafts checked against evidence`, events };
}

function approvalGate(ctx: ToolContext, c: Checkpoints): StepResult<'approval_gate'> {
  const { targets, drafts } = c.draft_messages!;
  const output = targets.flatMap(target => {
    if (target.hold || target.watch) return [];
    const draft = drafts.find(row => row.id === target.draftId);
    return !draft ? [] : (['send_message', 'book_meeting'] as const).map((kind): Approval => {
      const idempotencyKey = hash([ctx.runId, target.companyId, draft.personId ?? '', draft.body, kind].join('|')).slice(0, 16);
      return {
        id: `ap_${idempotencyKey}`, runId: ctx.runId, companyId: target.companyId, draftId: draft.id, kind,
        status: 'pending', idempotencyKey, createdAt: now(),
      };
    });
  });
  return { output, summary: `${output.length} test-mode actions ready for review`,
    events: [...output.map(approval => ({ type: 'approval.requested' as const, approval })),
      ...(output.length ? [{ type: 'run.status' as const, status: 'awaiting_approval' as const }] : [])] };
}

async function scoreReplay(ctx: ToolContext, c: Checkpoints): Promise<StepResult<'score_replay'>> {
  const intent = c.parse_request!;
  const { companies, evidence, triggers } = c.enrich_companies!;
  const targets = c.rank_targets!.targets;
  const firstOrder = c.rank_targets!.baseline.hiringFilterCompanyIds;
  const headcount = unique(triggers.filter(trigger => trigger.kind === 'headcount_jump').map(trigger => trigger.companyId))
    .filter(id => {
      const growth = companies.find(company => company.id === id)?.headcountGrowthPct;
      return growth?.window === '1m' && growth.pct >= 30;
    });
  const predicted = new Set([...targets.filter(target => !target.hold).map(target => target.companyId), ...firstOrder, ...headcount]);
  const picked = companies.filter(company => predicted.has(company.id));
  const outcomes: OutcomeFact[] = [];
  const inHorizon = (date: string | null) => Boolean(date && date > intent.asOf && date <= intent.horizonEnd!);
  if (picked.length && intent.horizonEnd) {
    const time = { asOf: intent.horizonEnd, windowDays: Math.round((Date.parse(intent.horizonEnd) - Date.parse(intent.asOf)) / 86_400_000) };
    const input = { intent, companies: picked };
    for (const spec of [deps.jobSearchOutcomes, deps.personSearchOutcomes]) {
      const result = await readSource(ctx, spec, input, time);
      const dated = result.evidence.filter(row => row.verifiable && inHorizon(row.observedAt));
      const ids = new Set(dated.map(row => row.id));
      const matchedIds: string[] = [];
      for (const trigger of result.triggers) {
        const mention = result.mentions.find(row => row.key === trigger.companyId);
        const company = mention && picked.find(row => row.id === mention.key ||
          (row.domain && mention.domain && row.domain.toLowerCase() === mention.domain.toLowerCase()));
        const evidenceIds = trigger.evidenceIds.filter(id => ids.has(id));
        if (company && inHorizon(trigger.date) && evidenceIds.length && (trigger.kind === 'job_post' || trigger.kind === 'hire')) {
          matchedIds.push(...evidenceIds);
          const title = dated.find(row => evidenceIds.includes(row.id) &&
            /title|start_date/i.test(row.source.field ?? '') && typeof row.value === 'string')?.value;
          outcomes.push({ companyKey: company.id, date: trigger.date, kind: trigger.kind, evidenceIds, summary: trigger.summary,
            title: typeof title === 'string' ? title : undefined });
        }
      }
      ctx.store.transaction(() => publishSource(ctx, result, dated, matchedIds));
    }
  }
  const score = deps.scoreReplay(intent, targets, { firstOrder, headcount }, outcomes);
  const usedForPrediction = byId([...evidence, ...c.find_deciders!.evidence]);
  const output = {
    ...score,
    snapshotLabel: usedForPrediction.length && usedForPrediction.every(row => row.mode === 'fixture')
      ? `Fictional fixtures filtered through ${intent.asOf}`
      : score.snapshotLabel ?? `Current Crustdata index filtered to facts dated through ${intent.asOf}`,
    outcomeDefinition: score.outcomeDefinition ?? 'A dated infrastructure or inference job post or hire in the replay horizon.',
    factsAfterAsOfUsed: usedForPrediction.filter(row => row.observedAt && row.observedAt > intent.asOf).length,
  };
  return { output, summary: `${output.domino.hits}/${output.domino.predicted} DOMINO picks showed a dated outcome`,
    events: [...output.outcomes.map(outcome => ({ type: 'replay.outcome' as const, outcome })), { type: 'replay.scored', score: output }] };
}

export const steps: { [K in StepName]: Runner<K> } = {
  parse_request: parseRequest, pull_triggers: pullTriggers, resolve_entities: resolveEntities, enrich_companies: enrichCompanies,
  cascade, rank_targets: rankTargets, find_deciders: findDeciders, warm_paths: warmPaths, draft_messages: draftMessages,
  approval_gate: approvalGate, score_replay: scoreReplay,
  ...openingsSteps, ...candidateSteps,
};

function safeJson<T>(text: string, shape: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T | null {
  try {
    const result = shape.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
