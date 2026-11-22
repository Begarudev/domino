// Pure reducer: applies RunEvents onto a RunSnapshot-shaped state.
// Every array write is an upsert by id, so re-applying an event the snapshot
// already reflects (snapshot fetched, then stream replayed from seq 0) is harmless.
import type {
  Approval, BudgetState, DeliveryReceipt, Draft, Evidence, GraphEdge, GraphNode, LedgerEntry, ReplayOutcome, RunSnapshot,
  StepName, StepState, StoredEvent, Target,
} from '../../shared/types.ts';
import { STEP_ORDER } from '../../shared/types.ts';

export const STEP_LABELS: Record<StepName, string> = {
  parse_request: 'Read the request',
  pull_triggers: 'Pull dated triggers',
  resolve_entities: 'Resolve companies and people',
  enrich_companies: 'Enrich companies',
  cascade: 'Build the cascade',
  rank_targets: 'Rank targets',
  find_deciders: 'Find who decides',
  warm_paths: 'Check warm paths',
  draft_messages: 'Draft and verify messages',
  approval_gate: 'Wait for approval',
  score_replay: 'Score the replay',
  scope_search: 'Scope the search', pull_departures: 'Pull departures', resolve_departures: 'Resolve companies',
  check_replacements: 'Check for replacements', detect_openings: 'Predict openings', score_openings: 'Score the replay',
  fetch_profile: 'Fetch the profile', parse_profile: 'Read the profile', match_openings: 'Match openings',
  draft_intro: 'Draft the intro', intro_gate: 'Wait for approval',
};

export type Tone = 'info' | 'retry' | 'fail' | 'ok' | 'warn' | 'entity' | 'engine';

export interface TimelineItem {
  seq: number;
  ts: string;
  step: StepName | null;
  tone: Tone;
  text: string;
  detail?: string;
  /** a full-width rule, used for crash and resume */
  rule?: boolean;
}

export interface UIState {
  snap: RunSnapshot;
  lastSeq: number;
  seen: Record<number, true>;
  timeline: TimelineItem[];
  durations: Partial<Record<StepName, number>>;
  currentStep: StepName | null;
  /** approvalId -> message shown under the approval buttons */
  actionNotes: Record<string, { kind: 'sent' | 'duplicate'; text: string; key: string }>;
  /** bumped every time the cascade finishes building, to start the tipping animation */
  cascadeEpoch: number;
  /** replay outcomes as they stream in, before replay.scored lands */
  outcomes: ReplayOutcome[];
  /** approvalId -> receipt from the test-inbox receiver */
  receipts: Record<string, DeliveryReceipt>;
  /** tool calls that fell back from live to cached responses */
  fallbacks: number;
  /** every event so far in seq order (the centrepiece contract hands these to the slot) */
  events: StoredEvent[];
}

export function emptyBudget(): BudgetState {
  return { limits: { maxCredits: 800, maxModelUsd: 1, maxSeconds: 300 }, used: { credits: 0, modelUsd: 0, seconds: 0 }, exhausted: null };
}

export function emptySteps(): StepState[] {
  return STEP_ORDER.map((step) => ({ step, label: STEP_LABELS[step], status: 'pending', attempt: 0 }));
}

export function emptySnapshot(id: string, request: string): RunSnapshot {
  const now = new Date().toISOString();
  return {
    id, request, status: 'queued', dataMode: 'fixture', llm: 'template', createdAt: now, updatedAt: now,
    intent: null, steps: emptySteps(), budget: emptyBudget(), companies: [], people: [], triggers: [], merges: [],
    keptApart: [], graph: { nodes: [], edges: [] }, targets: [], drafts: [], evidence: [], approvals: [], outbox: [], receipts: [],
    ledger: [], asks: [], baseline: { hiringFilterCompanyIds: [] }, engine: { pid: null, alive: false, crashes: 0, resumes: 0 },
    replay: null,
  };
}

export function initialState(snap: RunSnapshot): UIState {
  const cascadeDone = snap.steps.find((s) => s.step === 'cascade')?.status === 'done';
  return {
    snap: normalizeSnapshot(snap), lastSeq: 0, seen: {}, timeline: [], durations: {}, currentStep: null,
    actionNotes: {}, receipts: {}, fallbacks: 0, events: [], outcomes: snap.replay?.outcomes ?? [], cascadeEpoch: cascadeDone && snap.graph.edges.length ? 1 : 0,
  };
}

/** Fill gaps a partially implemented server may leave, so components can trust the shape. */
export function normalizeSnapshot(s: RunSnapshot): RunSnapshot {
  const steps = STEP_ORDER.map((step) => s.steps?.find((x) => x.step === step) ?? { step, label: STEP_LABELS[step], status: 'pending' as const, attempt: 0 });
  return {
    ...emptySnapshot(s.id, s.request),
    ...s,
    steps,
    graph: { nodes: s.graph?.nodes ?? [], edges: s.graph?.edges ?? [] },
    budget: s.budget ?? emptyBudget(),
    baseline: s.baseline ?? { hiringFilterCompanyIds: [] },
    engine: s.engine ?? { pid: null, alive: false, crashes: 0, resumes: 0 },
  };
}

function upsert<T>(list: T[], item: T, key: (x: T) => string | number): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function upsertMany<T>(list: T[], items: T[], key: (x: T) => string | number): T[] {
  return items.reduce((acc, it) => upsert(acc, it, key), list);
}

function setStep(steps: StepState[], step: StepName, patch: Partial<StepState>): StepState[] {
  return steps.map((s) => (s.step === step ? { ...s, ...patch } : s));
}

const companyName = (snap: RunSnapshot, id: string) =>
  snap.companies.find((c) => c.id === id)?.name ?? snap.graph.nodes.find((n) => n.id === id)?.name ?? null;

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const RETRY_REASON: Record<string, string> = {
  timeout: 'timed out', http_5xx: 'returned a server error', rate_limit: 'was rate limited',
  nonsense: 'returned a response that failed validation', network: 'had a network error',
};

export function reduce(state: UIState, stored: StoredEvent): UIState {
  if (state.seen[stored.seq]) return state;
  const ev = stored.event;
  let snap: RunSnapshot = { ...state.snap, updatedAt: stored.ts };
  let { currentStep, cascadeEpoch } = state;
  const durations = { ...state.durations };
  let actionNotes = state.actionNotes;
  let outcomes = state.outcomes;
  let receipts = state.receipts;
  let fallbacks = state.fallbacks;
  const items: Omit<TimelineItem, 'seq' | 'ts'>[] = [];
  const note = (tone: Tone, text: string, extra: Partial<TimelineItem> = {}) =>
    items.push({ step: currentStep, tone, text, ...extra });

  switch (ev.type) {
    case 'run.status':
      snap.status = ev.status;
      if (ev.status === 'budget_exhausted') note('fail', `Budget ceiling reached${ev.note ? `: ${ev.note}` : ''}. Partial result kept.`);
      else if (ev.status === 'failed') note('fail', ev.note ?? 'Run failed');
      else if (ev.status === 'completed') note('ok', ev.note ?? 'Run finished');
      break;
    case 'step.started':
      currentStep = ev.step;
      snap.steps = setStep(snap.steps, ev.step, { status: 'running', attempt: ev.attempt, startedAt: stored.ts, label: ev.label || STEP_LABELS[ev.step] });
      break;
    case 'step.completed':
      snap.steps = setStep(snap.steps, ev.step, { status: 'done', finishedAt: stored.ts, summary: ev.summary });
      durations[ev.step] = ev.durationMs;
      if (ev.step === 'cascade') cascadeEpoch += 1;
      break;
    case 'step.skipped':
      snap.steps = setStep(snap.steps, ev.step, { status: 'done', resumedFromCheckpoint: true });
      break;
    case 'step.failed':
      snap.steps = setStep(snap.steps, ev.step, { status: 'failed', summary: ev.error });
      note('fail', ev.error, { step: ev.step });
      break;
    case 'tool.retry':
      note('retry', `${ev.endpoint} ${RETRY_REASON[ev.reason] ?? ev.reason}${ev.injected ? ' (injected)' : ''}, retried in ${secs(ev.backoffMs)}`, { detail: `attempt ${ev.attempt + 1}` });
      break;
    case 'tool.fallback':
      fallbacks += 1;
      note('warn', `${ev.endpoint} fell back from ${ev.from} to ${ev.to}`, { detail: ev.reason });
      break;
    case 'ledger.entry':
      snap.ledger = upsert<LedgerEntry>(snap.ledger, ev.entry, (x) => x.id);
      break;
    case 'budget.update':
      snap.budget = ev.budget;
      break;
    case 'entity.merged':
      snap.merges = upsert(snap.merges, ev.merge, (m) => `${m.canonicalId}|${m.names.join('+')}`);
      note('entity', `Merged ${ev.merge.names.map((n) => `“${n}”`).join(' and ')} into one record`, { detail: ev.merge.reason });
      break;
    case 'entity.kept_apart':
      snap.keptApart = upsert(snap.keptApart, ev.decision, (d) => d.ids.join('|'));
      note('entity', `Kept ${ev.decision.names.map((n) => `“${n}”`).join(' and ')} apart`, { detail: ev.decision.reason });
      break;
    case 'evidence.added':
      snap.evidence = upsertMany<Evidence>(snap.evidence, ev.evidence, (e) => e.id);
      break;
    case 'trigger.found':
      snap.triggers = upsert(snap.triggers, ev.trigger, (t) => t.id);
      break;
    case 'graph.node':
      snap.graph = { ...snap.graph, nodes: upsert<GraphNode>(snap.graph.nodes, ev.node, (n) => n.id) };
      if (!snap.companies.some((c) => c.id === ev.node.id)) {
        snap.companies = [...snap.companies, { id: ev.node.id, name: ev.node.name, aliases: [ev.node.name], evidenceIds: ev.node.evidenceIds }];
      }
      break;
    case 'graph.edge':
      snap.graph = { ...snap.graph, edges: upsert<GraphEdge>(snap.graph.edges, ev.edge, (e) => e.id) };
      break;
    case 'targets.ranked':
      snap.targets = ev.targets;
      snap.baseline = ev.baseline;
      break;
    case 'decider.found':
      snap.targets = snap.targets.map((t): Target => (t.companyId === ev.companyId ? { ...t, decider: ev.decider } : t));
      break;
    case 'path.found':
      snap.targets = snap.targets.map((t): Target => (t.companyId === ev.companyId ? { ...t, path: ev.path } : t));
      break;
    case 'draft.ready':
      snap.drafts = upsert<Draft>(snap.drafts, ev.draft, (d) => d.id);
      snap.targets = snap.targets.map((t) => (t.companyId === ev.draft.companyId ? { ...t, draftId: ev.draft.id } : t));
      break;
    case 'claim.unverifiable':
      note('warn', `Can't verify: ${ev.claim}`, { detail: companyName(snap, ev.companyId) ? `${companyName(snap, ev.companyId)}: ${ev.reason}` : ev.reason });
      break;
    case 'ask.requested':
      snap.asks = upsert(snap.asks, ev.ask, (a) => a.id);
      note('warn', `Asked: ${ev.ask.question}`, { detail: ev.ask.why });
      break;
    case 'ask.answered':
      snap.asks = snap.asks.map((a) => (a.id === ev.askId ? { ...a, answer: ev.answer } : a));
      note('ok', `Answered: ${ev.answer}`);
      break;
    case 'approval.requested':
      snap.approvals = upsert<Approval>(snap.approvals, ev.approval, (a) => a.id);
      break;
    case 'approval.decided':
      snap.approvals = snap.approvals.map((a) => (a.id === ev.approvalId ? { ...a, status: ev.status, decidedAt: stored.ts } : a));
      break;
    case 'action.executed': {
      snap.outbox = upsert(snap.outbox, ev.action, (o) => o.idempotencyKey);
      const what = ev.action.kind === 'send_message' ? 'Sent once to test inbox' : 'Meeting hold booked once (test mode)';
      actionNotes = { ...actionNotes, [ev.action.approvalId]: { kind: 'sent', key: ev.action.idempotencyKey, text: what } };
      note('ok', `${what}, key ${shortKey(ev.action.idempotencyKey)}`, { step: 'approval_gate' });
      break;
    }
    case 'action.duplicate_blocked': {
      actionNotes = { ...actionNotes, [ev.approvalId]: { kind: 'duplicate', key: ev.idempotencyKey, text: 'Already sent, not sent again' } };
      note('retry', `Duplicate blocked, key ${shortKey(ev.idempotencyKey)}`, { step: 'approval_gate', detail: ev.note });
      break;
    }
    case 'delivery.receipt':
      receipts = { ...receipts, [ev.approvalId]: ev.receipt };
      note(ev.receipt.status === 'already_delivered' ? 'ok' : 'ok',
        ev.receipt.status === 'already_delivered' ? `Test inbox already had key ${shortKey(ev.receipt.idempotencyKey)}, skipped` : `Test inbox received key ${shortKey(ev.receipt.idempotencyKey)}`,
        { step: 'approval_gate', detail: ev.receipt.status === 'already_delivered' ? 'Retry after an interrupted send; the receiver blocked the second delivery' : undefined });
      break;
    case 'target.held':
      snap.targets = snap.targets.map((t): Target => (t.companyId === ev.companyId ? { ...t, hold: { reasons: ev.reasons } } : t));
      note('warn', `${companyName(snap, ev.companyId) ?? ev.companyId} put on hold`, { detail: ev.reasons.join('; ') });
      break;
    case 'engine.started':
      snap.engine = { ...snap.engine, pid: ev.pid, alive: true };
      break;
    case 'engine.crashed':
      snap.engine = { ...snap.engine, alive: false, crashes: snap.engine.crashes + 1 };
      if (ev.atStep) snap.steps = setStep(snap.steps, ev.atStep, { status: 'failed', summary: 'Engine killed mid-step' });
      note('fail', `Engine killed${ev.atStep ? ` at ${STEP_LABELS[ev.atStep].toLowerCase()}` : ''}`, {
        rule: true, step: ev.atStep, detail: `pid ${ev.pid}${ev.signal ? `, ${ev.signal}` : ''}`,
      });
      break;
    case 'engine.resumed': {
      snap.engine = { ...snap.engine, alive: true, resumes: snap.engine.resumes + 1 };
      const repeated = 0;
      note('engine', `Resumed: ${ev.skipped.length} steps reused from checkpoint, ${repeated} calls repeated`, {
        rule: true, step: ev.fromStep, detail: `continuing at ${STEP_LABELS[ev.fromStep].toLowerCase()}`,
      });
      currentStep = ev.fromStep;
      break;
    }
    case 'replay.outcome':
      outcomes = upsert(outcomes, ev.outcome, (o) => `${o.companyId}|${o.predictedBy}`);
      if (snap.replay) snap.replay = { ...snap.replay, outcomes: upsert(snap.replay.outcomes, ev.outcome, (o) => `${o.companyId}|${o.predictedBy}`) };
      break;
    case 'replay.scored':
      snap.replay = ev.score;
      break;
    case 'log':
      if (ev.level !== 'info') note(ev.level === 'error' ? 'fail' : 'warn', ev.message);
      break;
    case 'tool.call':
    case 'tool.result':
      break;
  }

  const timeline = items.length
    ? [...state.timeline, ...items.map((it) => ({ ...it, seq: stored.seq, ts: stored.ts }))]
    : state.timeline;

  return {
    ...state, snap, currentStep, durations, actionNotes, timeline, cascadeEpoch, outcomes, receipts, fallbacks,
    events: [...state.events, stored], lastSeq: Math.max(state.lastSeq, stored.seq), seen: { ...state.seen, [stored.seq]: true },
  };
}

export function shortKey(key: string) {
  return `${key.slice(0, 4)}…`;
}

export type Action =
  | { type: 'events'; events: StoredEvent[] }
  | { type: 'snapshot'; snap: RunSnapshot }
  | { type: 'reset'; snap: RunSnapshot }
  | { type: 'evidence'; evidence: Evidence };

export function uiReducer(state: UIState, action: Action): UIState {
  switch (action.type) {
    case 'events':
      return action.events.reduce(reduce, state);
    case 'snapshot': {
      // The server snapshot is authoritative for data; keep the event-derived timeline.
      const snap = normalizeSnapshot(action.snap);
      const cascadeDone = snap.steps.find((s) => s.step === 'cascade')?.status === 'done';
      const epoch = state.cascadeEpoch === 0 && cascadeDone && snap.graph.edges.length ? 1 : state.cascadeEpoch;
      return { ...state, snap, cascadeEpoch: epoch };
    }
    case 'reset':
      return initialState(action.snap);
    case 'evidence':
      return { ...state, snap: { ...state.snap, evidence: upsert(state.snap.evidence, action.evidence, (e) => e.id) } };
  }
}
