// Mission control view model. Everything here is derived from the RunSnapshot and the StoredEvent log the host
// app already has; this module never fetches, never decides, and never invents a fact.
import type {
  Approval, Draft, Evidence, GraphEdge, GraphNode, LedgerEntry, Mechanism, OutboxAction, ReplayOutcome, ReplayScore,
  RunSnapshot, StepName, StoredEvent, Trigger,
} from '../../../../shared/types.ts';

export const STEP_SHORT: Record<StepName, string> = {
  parse_request: 'Read request',
  pull_triggers: 'Pull triggers',
  resolve_entities: 'Resolve',
  enrich_companies: 'Enrich',
  cascade: 'Cascade',
  rank_targets: 'Rank',
  find_deciders: 'Deciders',
  warm_paths: 'Warm paths',
  draft_messages: 'Draft + verify',
  approval_gate: 'Approval',
  score_replay: 'Replay score',
};

export const MECHANISM_LABEL: Record<Mechanism, string> = {
  TALENT_DRAIN: 'Talent drain',
  DISPLACEMENT: 'Displacement',
  CONTAGION: 'Contagion',
  CAPITAL: 'Capital',
  DIRECT: 'Direct (first-order)',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function day(iso: string | null | undefined, withYear = false): string {
  if (!iso) return 'undated';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

export function dayRange(dates: (string | null | undefined)[]): string {
  const ds = dates.filter((d): d is string => !!d).sort();
  if (!ds.length) return 'undated';
  if (ds[0] === ds[ds.length - 1]) return day(ds[0], true);
  return `${day(ds[0])} – ${day(ds[ds.length - 1], true)}`;
}

export function dayNumber(iso: string): number {
  return Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / 86400000);
}

export function isoFromDay(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function shortKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ---------- call stream ----------

export type StreamRow =
  | { key: string; seq: number; kind: 'call'; entry: LedgerEntry }
  | { key: string; seq: number; kind: 'step'; step: StepName; skipped: boolean }
  | { key: string; seq: number; kind: 'engine'; tone: 'crash' | 'resume'; text: string; sub: string }
  | { key: string; seq: number; kind: 'note'; tone: 'warn' | 'fail' | 'ok' | 'info'; text: string };

export function streamRows(events: StoredEvent[], snap: RunSnapshot): StreamRow[] {
  const rows: StreamRow[] = [];
  const names = new Map(snap.companies.map((c) => [c.id, c.name] as const));
  for (const n of snap.graph.nodes) if (!names.has(n.id)) names.set(n.id, n.name);
  for (const { seq, event: ev } of events) {
    const key = `r${seq}`;
    switch (ev.type) {
      case 'ledger.entry':
        rows.push({ key, seq, kind: 'call', entry: ev.entry });
        break;
      case 'step.started':
        rows.push({ key, seq, kind: 'step', step: ev.step, skipped: false });
        break;
      case 'step.skipped':
        rows.push({ key, seq, kind: 'step', step: ev.step, skipped: true });
        break;
      case 'tool.retry':
        rows.push({ key, seq, kind: 'note', tone: 'warn', text: `${ev.injected ? 'Injected ' : ''}${ev.reason.replace('_', ' ')}: retry ${ev.attempt + 1} in ${ev.backoffMs} ms` });
        break;
      case 'tool.fallback':
        rows.push({ key, seq, kind: 'note', tone: 'warn', text: `${ev.endpoint}: ${ev.from} failed, used ${ev.to}` });
        break;
      case 'entity.merged':
        rows.push({ key, seq, kind: 'note', tone: 'info', text: `Merged ${ev.merge.names.map((n) => `“${n}”`).join(' + ')}` });
        break;
      case 'entity.kept_apart':
        rows.push({ key, seq, kind: 'note', tone: 'info', text: `Kept apart ${ev.decision.names.map((n) => `“${n}”`).join(' / ')}` });
        break;
      case 'claim.unverifiable':
        rows.push({ key, seq, kind: 'note', tone: 'fail', text: `I can't verify: ${ev.claim}` });
        break;
      case 'engine.crashed':
        rows.push({ key, seq, kind: 'engine', tone: 'crash', text: `Engine pid ${ev.pid} killed`, sub: `${ev.signal ?? 'exit'} during ${ev.atStep ? STEP_SHORT[ev.atStep] : 'start-up'}` });
        break;
      case 'engine.resumed':
        rows.push({ key, seq, kind: 'engine', tone: 'resume', text: `Resumed at ${STEP_SHORT[ev.fromStep]}`, sub: `${ev.skipped.length} steps reused from the checkpoint` });
        break;
      case 'action.executed':
        rows.push({ key, seq, kind: 'note', tone: 'ok', text: `${ev.action.kind === 'send_message' ? 'Sent once' : 'Hold booked'} · key ${shortKey(ev.action.idempotencyKey)}` });
        break;
      case 'action.duplicate_blocked':
        rows.push({ key, seq, kind: 'note', tone: 'warn', text: `Already sent, skipped · key ${shortKey(ev.idempotencyKey)}` });
        break;
      case 'run.status':
        if (ev.status === 'budget_exhausted') rows.push({ key, seq, kind: 'note', tone: 'fail', text: `Stopped at the cap: ${ev.note ?? 'partial result kept'}` });
        break;
      default:
        break;
    }
  }
  return rows;
}

// ---------- engine state ----------

export interface EngineView {
  crashed: { seq: number; pid: number; atStep: StepName | null } | null;
  lastResume: { seq: number; fromStep: StepName; skipped: StepName[] } | null;
  pid: number | null;
}

export function engineView(events: StoredEvent[]): EngineView {
  let crashed: EngineView['crashed'] = null;
  let lastResume: EngineView['lastResume'] = null;
  let pid: number | null = null;
  for (const { seq, event: ev } of events) {
    if (ev.type === 'engine.started') { pid = ev.pid; crashed = null; }
    if (ev.type === 'engine.crashed') crashed = { seq, pid: ev.pid, atStep: ev.atStep };
    if (ev.type === 'engine.resumed') lastResume = { seq, fromStep: ev.fromStep, skipped: ev.skipped };
  }
  return { crashed, lastResume, pid };
}

// ---------- the chain ----------

export interface ChainTile {
  nodeId: string;
  name: string;
  fact: string;
  dates: string;
  pips: number;               // dated, verifiable evidence rows behind this tile
  stampEndpoint: string | null;
  stampEvidenceId: string | null;
  netNew: boolean;
}

export interface ChainRow {
  edge: GraphEdge;
  seq: number;                // when the edge arrived (0 = already in the snapshot)
  from: ChainTile;
  to: ChainTile;
  need: { text: string; confidence: number; mechanism: Mechanism; datedRows: number; netNew: boolean };
  unverifiable: { claim: string; reason: string } | null;
}

function datedRows(ids: string[], ev: Map<string, Evidence>): Evidence[] {
  return ids.map((id) => ev.get(id)).filter((e): e is Evidence => !!e && e.verifiable && !!e.observedAt);
}

function tileFor(node: GraphNode | undefined, nodeId: string, other: string, snap: RunSnapshot, ev: Map<string, Evidence>, fallback: string): ChainTile {
  const triggers = snap.triggers.filter((t) => t.companyId === nodeId);
  const trig: Trigger | undefined = triggers.find((t) => t.relatedCompanyId === other) ?? triggers[0];
  const ids = trig ? trig.evidenceIds : node?.evidenceIds ?? [];
  const rows = datedRows(ids, ev);
  const first = rows[0] ?? null;
  return {
    nodeId,
    name: node?.name ?? snap.companies.find((c) => c.id === nodeId)?.name ?? nodeId,
    fact: trig?.summary ?? fallback,
    dates: rows.length ? dayRange(rows.map((r) => r.observedAt)) : trig ? day(trig.date, true) : 'undated',
    pips: rows.length,
    stampEndpoint: first?.source.endpoint ?? null,
    stampEvidenceId: first?.id ?? null,
    netNew: node?.netNew ?? false,
  };
}

export function chainRows(snap: RunSnapshot, events: StoredEvent[]): ChainRow[] {
  const ev = new Map(snap.evidence.map((e) => [e.id, e] as const));
  const nodes = new Map(snap.graph.nodes.map((n) => [n.id, n] as const));
  const arrived = new Map<string, number>();
  const unverifiable = new Map<string, { claim: string; reason: string }>();
  for (const { seq, event } of events) {
    if (event.type === 'graph.edge' && !arrived.has(event.edge.id)) arrived.set(event.edge.id, seq);
    if (event.type === 'claim.unverifiable') unverifiable.set(event.companyId, { claim: event.claim, reason: event.reason });
  }
  return [...snap.graph.edges]
    .filter((e) => e.mechanism !== 'DIRECT' && e.mechanism !== 'CAPITAL')
    .sort((a, b) => a.order - b.order)
    .map((edge) => {
      const toNode = nodes.get(edge.to);
      const rows = datedRows(edge.evidenceIds, ev);
      const isUnverifiable = toNode?.status === 'unverifiable' || rows.length < 2;
      return {
        edge,
        seq: arrived.get(edge.id) ?? 0,
        from: tileFor(nodes.get(edge.from), edge.from, edge.to, snap, ev, edge.label),
        to: tileFor(toNode, edge.to, edge.from, snap, ev, edge.label),
        need: {
          text: toNode?.need ?? 'Need not stated',
          confidence: edge.confidence,
          mechanism: edge.mechanism,
          datedRows: rows.length,
          netNew: toNode?.netNew ?? false,
        },
        unverifiable: isUnverifiable
          ? unverifiable.get(edge.to) ?? { claim: edge.label, reason: `${rows.length} dated row${rows.length === 1 ? '' : 's'}; a rule needs two` }
          : null,
      };
    });
}

/** Claims the engine could not verify that are not already shown as a broken chain row. */
export function looseUnverifiable(events: StoredEvent[], rows: ChainRow[]): { seq: number; claim: string; reason: string; companyId: string }[] {
  const inRows = new Set(rows.filter((r) => r.unverifiable).map((r) => r.edge.to));
  const out: { seq: number; claim: string; reason: string; companyId: string }[] = [];
  for (const { seq, event } of events) {
    if (event.type === 'claim.unverifiable' && !inRows.has(event.companyId)) out.push({ seq, claim: event.claim, reason: event.reason, companyId: event.companyId });
  }
  return out;
}

// ---------- the approval gate ----------

export interface GateView {
  requestedSeq: number;
  draft: Draft;
  approval: Approval | null;
  decider: { name: string; title: string; company: string } | null;
  sent: { seq: number; action: OutboxAction } | null;
  duplicates: { seq: number; key: string }[];
  waitingMore: number;        // other send approvals still pending
  removed: number;            // sentences the verifier removed
  evidence: Map<string, Evidence>;
}

export function gateView(snap: RunSnapshot, events: StoredEvent[]): GateView | null {
  const top = [...snap.targets].sort((a, b) => a.rank - b.rank).find((t) => snap.drafts.some((d) => d.companyId === t.companyId));
  const draft = top ? snap.drafts.find((d) => d.companyId === top.companyId) : snap.drafts[0];
  if (!draft) return null;
  const approval = snap.approvals.find((a) => a.draftId === draft.id && a.kind === 'send_message') ?? null;
  if (!approval) return null;
  let sent: GateView['sent'] = null;
  const duplicates: GateView['duplicates'] = [];
  let requestedSeq = 0;
  for (const { seq, event } of events) {
    if (event.type === 'approval.requested' && event.approval.id === approval.id && !requestedSeq) requestedSeq = seq;
    if (event.type === 'action.executed' && event.action.approvalId === approval.id) sent = { seq, action: event.action };
    if (event.type === 'action.duplicate_blocked' && event.approvalId === approval.id) duplicates.push({ seq, key: event.idempotencyKey });
  }
  if (!sent) {
    const ob = snap.outbox.find((o) => o.approvalId === approval.id);
    if (ob) sent = { seq: 0, action: ob };
  }
  const company = snap.companies.find((c) => c.id === draft.companyId)?.name ?? snap.graph.nodes.find((n) => n.id === draft.companyId)?.name ?? '';
  const d = top?.decider ?? null;
  return {
    requestedSeq,
    draft,
    approval,
    decider: d ? { name: d.name, title: d.title, company } : null,
    sent,
    duplicates,
    waitingMore: snap.approvals.filter((a) => a.kind === 'send_message' && a.status === 'pending' && a.id !== approval.id).length,
    removed: draft.checks.filter((c) => c.status === 'removed').length,
    evidence: new Map(snap.evidence.map((e) => [e.id, e] as const)),
  };
}

// ---------- replay ----------

export interface ReplayView {
  score: ReplayScore | null;
  outcomes: ReplayOutcome[];
  asOf: string;
  horizonEnd: string;
  scoredSeq: number;
}

export function replayView(snap: RunSnapshot, events: StoredEvent[]): ReplayView | null {
  let outcomes: ReplayOutcome[] = [];
  let score: ReplayScore | null = snap.replay;
  let scoredSeq = 0;
  for (const { seq, event } of events) {
    if (event.type === 'replay.outcome') outcomes.push(event.outcome);
    if (event.type === 'replay.scored') { score = event.score; scoredSeq = seq; }
  }
  if (score) outcomes = score.outcomes;
  if (!score && !outcomes.length) return null;
  const asOf = score?.asOf ?? snap.intent?.asOf ?? '2026-09-01';
  const horizonEnd = score?.horizonEnd ?? snap.intent?.horizonEnd ?? '2026-11-22';
  return { score, outcomes, asOf, horizonEnd, scoredSeq };
}

export function companyName(snap: RunSnapshot, id: string): string {
  return snap.companies.find((c) => c.id === id)?.name ?? snap.graph.nodes.find((n) => n.id === id)?.name ?? id.replace(/^co_/, '');
}

// ---------- the reading desk ----------

export interface SourceCard {
  id: string; seq: number; claim: string; value: string | null; endpoint: string; kind: string; kindLabel: string;
  observedAt: string | null; dated: boolean; mode: string;
}

export interface DeskView {
  pending: { endpoint: string; attempt: number; seq: number } | null;
  cards: SourceCard[];
  dated: number;
  signalCount: number;
  companies: { id: string; name: string; alias: string | null; seq: number; signals: { id: string; seq: number; kind: string; kindLabel: string; summary: string; date: string }[] }[];
  keptApart: string[];
}

export function sourceKind(endpoint: string): [string, string] {
  if (endpoint.includes('job')) return ['job', 'Job post'];
  if (endpoint.includes('social') || endpoint.includes('post')) return ['post', 'LinkedIn post'];
  if (endpoint.includes('person')) return ['person', 'People move'];
  if (endpoint.includes('news')) return ['news', 'News'];
  if (endpoint.includes('web')) return ['web', 'Web page'];
  if (endpoint.includes('company/search')) return ['company', 'Company search'];
  if (endpoint.includes('company')) return ['company', 'Company profile'];
  return ['other', 'Source'];
}

const TRIGGER_LABEL: Record<string, string> = {
  job_post: 'Job post', hire: 'Hires', departure: 'Departures', headcount_jump: 'Headcount', funding: 'Funding', post: 'News',
};

export function deskView(events: StoredEvent[], snap: RunSnapshot): DeskView {
  const cards: SourceCard[] = [];
  const seen = new Set<string>();
  const cos = new Map<string, DeskView['companies'][number]>();
  const nameOf = (id: string) => companyName(snap, id);
  const keptApart: string[] = [];
  let signalCount = 0;
  const claims = new Map<string, string>();
  for (const { event } of events) if (event.type === 'evidence.added') for (const e of event.evidence) claims.set(e.id, e.claim);
  // Before enrichment the snapshot may not know the display name yet; the evidence claim that produced the
  // trigger starts with it ("Kestrel Labs hired ..."), so read the leading capitalised words.
  const nameFromTrigger = (id: string, evIds: string[]) => {
    const known = nameOf(id);
    if (known !== id.replace(/^co_/, '')) return known;
    for (const ev of evIds) {
      const m = claims.get(ev)?.match(/^((?:[A-Z0-9][\w.&'-]*\s?)+)/);
      if (m) return m[1].trim().replace(/'s$/, '');
    }
    return known;
  };
  const open = new Map<string, { endpoint: string; attempt: number; seq: number }>();
  for (const { seq, event } of events) {
    if (event.type === 'tool.call') open.set(event.callId, { endpoint: event.endpoint, attempt: event.attempt, seq });
    if (event.type === 'tool.result' || event.type === 'tool.fallback') open.delete(event.callId);
    if (event.type === 'engine.crashed') open.clear();
    if (event.type === 'evidence.added') {
      for (const e of event.evidence) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const [kind, kindLabel] = sourceKind(e.source.endpoint);
        cards.push({
          id: e.id, seq, claim: e.claim, value: e.value == null || e.value === '' ? null : String(e.value), endpoint: e.source.endpoint,
          kind, kindLabel, observedAt: e.observedAt, dated: e.verifiable && !!e.observedAt, mode: e.mode,
        });
      }
    }
    if (event.type === 'trigger.found') {
      const t = event.trigger;
      let co = cos.get(t.companyId);
      if (!co) { co = { id: t.companyId, name: nameFromTrigger(t.companyId, t.evidenceIds), alias: null, seq, signals: [] }; cos.set(t.companyId, co); }
      if (!co.signals.some((s) => s.id === t.id)) {
        co.signals.push({ id: t.id, seq, kind: t.kind, kindLabel: TRIGGER_LABEL[t.kind] ?? t.kind, summary: t.summary, date: t.date });
        signalCount++;
      }
    }
    if (event.type === 'entity.merged' && event.merge.kind === 'company') {
      const co = cos.get(event.merge.canonicalId);
      const other = event.merge.names.find((n) => n !== (co?.name ?? event.merge.names[0]));
      if (co && other) co.alias = other;
    }
    if (event.type === 'entity.kept_apart' && event.decision.kind === 'company') keptApart.push(`${event.decision.names.join(' and ')} (${event.decision.reason})`);
  }
  const pending = [...open.values()].at(-1) ?? null;
  return { pending, cards, dated: cards.filter((c) => c.dated).length, signalCount, companies: [...cos.values()], keptApart };
}

// ---------- narration: one plain sentence about what the engine is doing right now ----------

const STEP_DOING: Record<StepName, string> = {
  parse_request: 'Reading the request and working out what you sell',
  pull_triggers: 'Searching Crustdata for dated job posts, hires and headcount changes',
  resolve_entities: 'Working out which mentions are the same company',
  enrich_companies: 'Pulling company profiles: headcount, funding, peers',
  cascade: 'Looking for changes at one company that create a need at another',
  rank_targets: 'Ranking accounts against a plain hiring filter',
  find_deciders: 'Finding the one person who decides at each account',
  warm_paths: 'Checking for a warm route in',
  draft_messages: 'Writing first messages from numbered, dated claims only',
  approval_gate: 'Nothing is sent until a person approves',
  score_replay: 'Checking what actually happened after the frozen date',
};

export function narrate(events: StoredEvent[], snap: RunSnapshot): { seq: number; text: string; tone: 'info' | 'warn' | 'fail' | 'ok' } | null {
  const nameOf = (id: string) => companyName(snap, id);
  for (let i = events.length - 1; i >= 0; i--) {
    const { seq, event: ev } = events[i];
    switch (ev.type) {
      case 'step.started': return { seq, text: STEP_DOING[ev.step], tone: 'info' };
      case 'tool.call': return { seq, text: `Calling ${ev.endpoint}${ev.attempt > 1 ? ` again (try ${ev.attempt})` : ''}`, tone: 'info' };
      case 'tool.retry': return { seq, text: `${ev.endpoint.replace(/_/g, '/')} ${ev.reason === 'nonsense' ? 'sent back a malformed body' : ev.reason.replace('_', ' ')}${ev.injected ? ' (injected fault)' : ''}. Retrying in ${ev.backoffMs} ms`, tone: 'warn' };
      case 'tool.fallback': return { seq, text: `${ev.endpoint} failed live; using the ${ev.to} copy and labelling it`, tone: 'warn' };
      case 'evidence.added': {
        const e = ev.evidence[ev.evidence.length - 1];
        return e ? { seq, text: `Read ${ev.evidence.length} source${ev.evidence.length === 1 ? '' : 's'}: “${e.claim}”`, tone: 'info' } : null;
      }
      case 'trigger.found': return { seq, text: `Signal at ${nameOf(ev.trigger.companyId)}: ${ev.trigger.summary}, ${day(ev.trigger.date)}`, tone: 'info' };
      case 'entity.merged': return { seq, text: `${ev.merge.names.join(' and ')} are one company: ${ev.merge.reason}`, tone: 'info' };
      case 'entity.kept_apart': return { seq, text: `${ev.decision.names.join(' and ')} stay separate: ${ev.decision.reason}`, tone: 'info' };
      case 'claim.unverifiable': return { seq, text: `I can't verify “${ev.claim}”. ${ev.reason}. Leaving it out`, tone: 'fail' };
      case 'graph.node': return { seq, text: `${ev.node.name} enters the chain${ev.node.need ? `: ${ev.node.need.toLowerCase()}` : ''}`, tone: 'info' };
      case 'graph.edge': return { seq, text: `${nameOf(ev.edge.from)} → ${nameOf(ev.edge.to)}: ${ev.edge.label}`, tone: 'info' };
      case 'targets.ranked': {
        const nn = ev.targets.filter((t) => t.netNew).length;
        return { seq, text: `Ranked ${ev.targets.length} accounts; a hiring filter would miss ${nn} of them`, tone: 'ok' };
      }
      case 'target.held': return { seq, text: `${nameOf(ev.companyId)} put on hold: ${ev.reasons.join('; ')}`, tone: 'warn' };
      case 'decider.found': return { seq, text: ev.decider ? `${ev.decider.name}, ${ev.decider.title}, decides at ${nameOf(ev.companyId)}` : `No decider verified at ${nameOf(ev.companyId)}`, tone: 'info' };
      case 'path.found': return { seq, text: ev.path ? `Route into ${nameOf(ev.companyId)}: ${ev.path.explanation}` : `No warm route into ${nameOf(ev.companyId)}`, tone: 'info' };
      case 'draft.ready': {
        const removed = ev.draft.checks.filter((c) => c.status === 'removed').length;
        return { seq, text: `Drafted to ${nameOf(ev.draft.companyId)}; the verifier removed ${removed} unsupported sentence${removed === 1 ? '' : 's'}`, tone: 'info' };
      }
      case 'approval.requested': return { seq, text: 'Draft verified. Nothing is sent until a person approves it', tone: 'info' };
      case 'action.executed': return { seq, text: `${ev.action.kind === 'send_message' ? 'Message' : 'Meeting hold'} written to the team test inbox, once`, tone: 'ok' };
      case 'action.duplicate_blocked': return { seq, text: 'Already sent. Same key, so nothing was sent twice', tone: 'warn' };
      case 'delivery.receipt': return { seq, text: ev.receipt.status === 'delivered' ? 'Test inbox confirmed delivery' : 'Test inbox already had it: already delivered, not delivered twice', tone: 'ok' };
      case 'engine.crashed': return { seq, text: `Engine killed during ${ev.atStep ? STEP_SHORT[ev.atStep] : 'start-up'}. State is safe in SQLite`, tone: 'fail' };
      case 'engine.resumed': return { seq, text: `Back up: ${ev.skipped.length} finished steps reused from the checkpoint, picking up at ${STEP_SHORT[ev.fromStep]}`, tone: 'ok' };
      case 'replay.outcome': return { seq, text: `${nameOf(ev.outcome.companyId)}: ${ev.outcome.outcome}`, tone: ev.outcome.hit ? 'ok' : 'info' };
      case 'replay.scored': return { seq, text: `Replay scored: DOMINO ${ev.score.domino.hits} of ${ev.score.domino.predicted}, hiring filter ${ev.score.baselineFirstOrder.hits} of ${ev.score.baselineFirstOrder.predicted}`, tone: 'ok' };
      case 'run.status':
        if (ev.status === 'budget_exhausted') return { seq, text: `Stopped at the credit cap. Partial result kept`, tone: 'fail' };
        if (ev.status === 'completed') return { seq, text: ev.note ?? 'Finished', tone: 'ok' };
        break;
      default:
        break;
    }
  }
  return null;
}
