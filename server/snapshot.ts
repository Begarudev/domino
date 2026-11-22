import type { CascadeGraph, Draft, Evidence, Intent, RunEvent, RunSnapshot, Target, Trigger } from '../shared/types.ts';
import { decode, Store } from './db.ts';
import { draftGate } from './engine/steps.ts';
import type { Checkpoints, Outputs } from './engine/steps.ts';

export function isAlive(pid: number | null): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function partialEvents(store: Store, id: string): RunEvent[] {
  return store.sql.prepare(`SELECT payload_json FROM events WHERE run_id = ?
    AND type IN ('trigger.found', 'graph.node', 'graph.edge') ORDER BY seq`).all(id)
    .map(row => decode(row.payload_json as string));
}

// Today's evidence gate, re-applied when a draft is served: a draft an older build marked ready but that has fewer than
// 2 verified, dated, cited facts or no named decider role is held, never offered for approval.
export function heldPreGate(draft: Draft, targets: Target[], evidence: Evidence[]): Draft | null {
  if (draft.status === 'not_drafted') return null;
  const target = targets.find(row => row.companyId === draft.companyId);
  const failed = target ? draftGate(draft, target, evidence) : { reason: 'Not drafted: no ranked target for this draft' };
  if (!failed) return null;
  return { ...draft, status: 'held_pre_gate', blockedReason: `Drafted before the evidence gate · not sendable (${failed.reason.replace(/^Not drafted: /, '')})` };
}

export function snapshot(store: Store, id: string): RunSnapshot {
  const run = store.requireRun(id);
  const { engine_pid: pid } = run;
  const steps = store.getSteps(id);
  const output: Checkpoints = {};
  const load = <K extends keyof Outputs>(step: K, json: string) => { output[step] = decode<Outputs[K]>(json); };
  for (const step of steps) if (step.status === 'done' && step.output_json) load(step.step, step.output_json);
  const resolved = output.enrich_companies ?? output.resolve_entities;
  const partialGraph: CascadeGraph = { nodes: [], edges: [] };
  const partialTriggers: Trigger[] = [];
  if (!output.cascade || !output.pull_triggers) {
    for (const event of partialEvents(store, id)) {
      if (event.type === 'trigger.found') partialTriggers.push(event.trigger);
      if (event.type === 'graph.node') partialGraph.nodes.push(event.node);
      if (event.type === 'graph.edge') partialGraph.edges.push(event.edge);
    }
  }
  const evidence = store.getEvidence(id);
  const drafts = (output.draft_messages?.drafts ?? []).map(draft => heldPreGate(draft, output.draft_messages!.targets, evidence) ?? draft);
  const fixtureRows = new Set(evidence.filter(row => row.mode === 'fixture').map(row => row.id));
  const fixtureCitations = run.data_mode === 'live'
    ? drafts.flatMap(draft => draft.citations).filter(cite => fixtureRows.has(cite.evidenceId)).length : 0;
  const integrity = fixtureCitations ? {
    fixtureCitations,
    note: `Pre-fix run: labelled live, but its drafts cite ${fixtureCitations} fixture row${fixtureCitations === 1 ? '' : 's'} ` +
      '(fictional companies). It ran before live runs stopped falling back to fixtures. Not live results.',
  } : undefined;
  return {
    ...(integrity && { integrity }),
    id, request: run.request, status: run.status, dataMode: run.data_mode, llm: run.llm,
    createdAt: run.created_at, updatedAt: run.updated_at, intent: run.intent_json ? decode<Intent>(run.intent_json) : null,
    steps: steps.map(({ output_json: _, ...step }) => step), budget: store.budget(id),
    companies: resolved?.companies ?? [], people: output.find_deciders?.people ?? resolved?.people ?? [],
    triggers: resolved?.triggers ?? output.pull_triggers?.triggers ?? partialTriggers,
    merges: output.resolve_entities?.merges ?? [], keptApart: output.resolve_entities?.keptApart ?? [],
    graph: output.cascade ?? partialGraph,
    targets: output.draft_messages?.targets ?? output.warm_paths ?? output.find_deciders?.targets ?? output.rank_targets?.targets ?? [],
    drafts, evidence, approvals: store.getApprovals(id),
    outbox: store.getOutbox(id), receipts: store.getReceipts(id), ledger: store.getLedger(id), asks: store.getAsks(id),
    baseline: output.rank_targets?.baseline ?? { hiringFilterCompanyIds: [] },
    engine: { pid, alive: isAlive(pid), crashes: run.crashes, resumes: run.resumes }, replay: output.score_replay ?? null,
  };
}
