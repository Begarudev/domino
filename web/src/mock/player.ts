// Plays a mock Scenario as a StoredEvent stream and simulates the server's side effects:
// SIGKILL + resume from checkpoint, asks, approvals through an idempotent outbox, limits, re-check.
import type { ApprovalKind, BudgetState, Evidence, OutboxAction, RunEvent, RunLimits, StepName, StoredEvent } from '../../../shared/types.ts';
import { STEP_ORDER } from '../../../shared/types.ts';
import type { Scenario } from './events.ts';

type Listener = (events: StoredEvent[]) => void;

export interface PlayerOptions { speed: number; autoCrash: boolean; instant: boolean }

export class MockRun {
  readonly scenario: Scenario;
  private opts: PlayerOptions;
  private log: StoredEvent[] = [];
  private listeners = new Set<Listener>();
  private idx = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private stepStart: Partial<Record<StepName, number>> = {};
  private attempts: Partial<Record<StepName, number>> = {};
  private done = new Set<StepName>();
  private current: StepName | null = null;
  private pid = 48211;
  private alive = false;
  private crashedOnce = false;
  private waiting: 'ask' | 'approval' | 'crashed' | 'budget' | null = null;
  private limits: RunLimits;
  private used: BudgetState['used'] = { credits: 0, modelUsd: 0, seconds: 0 };
  private approvals = new Map<string, { kind: ApprovalKind; key: string; status: 'pending' | 'approved' | 'rejected' }>();
  private outbox = new Set<string>();
  private finished = false;

  constructor(scenario: Scenario, opts: PlayerOptions) {
    this.scenario = scenario;
    this.opts = opts;
    this.limits = { ...scenario.limits };
  }

  get events() { return this.log; }

  subscribe(after: number, fn: Listener): () => void {
    const backlog = this.log.filter((e) => e.seq > after);
    if (backlog.length) fn(backlog);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    this.alive = true;
    if (this.opts.instant) this.drain();
    else this.schedule();
  }

  private emit(event: RunEvent) {
    const stored: StoredEvent = { seq: ++this.seq, runId: this.scenario.runId, ts: new Date().toISOString(), event };
    this.log.push(stored);
    return stored;
  }

  private flush(batch: StoredEvent[]) {
    if (!batch.length) return;
    for (const l of this.listeners) l(batch);
  }

  private send(...events: RunEvent[]) {
    this.flush(events.map((e) => this.emit(e)));
  }

  private schedule() {
    if (this.timer || this.waiting || this.idx >= this.scenario.script.length) return;
    const item = this.scenario.script[this.idx];
    this.timer = setTimeout(() => {
      this.timer = null;
      const out = this.advance();
      this.flush(out);
      this.schedule();
    }, item.delay / this.opts.speed);
  }

  /** instant mode: play everything up to the first pause in one batch (for screenshots) */
  private drain() {
    const out: StoredEvent[] = [];
    while (!this.waiting && this.idx < this.scenario.script.length) out.push(...this.advance());
    this.flush(out);
  }

  private advance(): StoredEvent[] {
    const item = this.scenario.script[this.idx];
    if (!item) return [];
    if (item.pause) {
      this.idx++;
      this.waiting = item.pause;
      return [];
    }
    let ev = item.event!;
    const out: StoredEvent[] = [];

    if (ev.type === 'step.started') {
      this.stepStart[ev.step] = this.idx;
      this.current = ev.step;
      const attempt = (this.attempts[ev.step] ?? 0) + 1;
      this.attempts[ev.step] = attempt;
      ev = { ...ev, attempt };
    }
    if (ev.type === 'step.completed') this.done.add(ev.step);
    if (ev.type === 'budget.update') {
      this.used = ev.budget.used;
      ev = { type: 'budget.update', budget: { limits: { ...this.limits }, used: { ...this.used }, exhausted: null } };
    }
    if (ev.type === 'tool.call' && ev.provider === 'crustdata' && ev.attempt === 1 && this.used.credits >= this.limits.maxCredits) {
      this.idx++;
      out.push(this.emit({ type: 'ledger.entry', entry: { id: 9000 + this.seq, runId: this.scenario.runId, ts: new Date().toISOString(), step: this.current ?? 'pull_triggers', provider: 'crustdata', endpoint: ev.endpoint, mode: 'live', status: 'budget_blocked', attempt: 1, credits: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0, injected: false } }));
      out.push(this.emit({ type: 'budget.update', budget: { limits: { ...this.limits }, used: { ...this.used }, exhausted: 'credits' } }));
      out.push(this.emit({ type: 'run.status', status: 'budget_exhausted', note: `credit ceiling ${this.limits.maxCredits} reached before ${ev.endpoint}` }));
      this.waiting = 'budget';
      return out;
    }
    if (ev.type === 'approval.requested') this.approvals.set(ev.approval.id, { kind: ev.approval.kind, key: ev.approval.idempotencyKey, status: 'pending' });
    if (ev.type === 'run.status' && ev.status === 'awaiting_approval') this.waiting = 'approval';
    if (ev.type === 'run.status' && ev.status === 'completed') this.finished = true;

    this.idx++;
    out.push(this.emit(ev));

    // The recorded run includes one SIGKILL at the cascade step, then an automatic resume.
    if (this.opts.autoCrash && !this.crashedOnce && this.current === 'cascade' && ev.type === 'graph.node' && this.countInStep('graph.node') === 3) {
      out.push(...this.crash());
      setTimeout(() => this.flush(this.doResume()), (this.opts.instant ? 0 : 2600) / this.opts.speed);
    }
    return out;
  }

  private countInStep(type: RunEvent['type']) {
    const start = this.stepStart[this.current!] ?? 0;
    let n = 0;
    for (let i = start; i < this.idx; i++) if (this.scenario.script[i].event?.type === type) n++;
    return n;
  }

  private crash(): StoredEvent[] {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.crashedOnce = true;
    this.alive = false;
    this.waiting = 'crashed';
    const at = this.current;
    if (at) this.idx = this.stepStart[at] ?? this.idx; // the unfinished step re-runs; finished steps never do
    return [
      this.emit({ type: 'engine.crashed', pid: this.pid, atStep: at, signal: 'SIGKILL' }),
      this.emit({ type: 'run.status', status: 'crashed', note: 'Engine process killed' }),
    ];
  }

  private doResume(): StoredEvent[] {
    if (this.waiting !== 'crashed') return [];
    this.pid += 7;
    this.alive = true;
    this.waiting = null;
    const skipped = STEP_ORDER.filter((s) => this.done.has(s));
    const from = this.current ?? 'parse_request';
    const out = [
      this.emit({ type: 'engine.started', pid: this.pid, resume: true }),
      this.emit({ type: 'engine.resumed', fromStep: from, skipped }),
      ...skipped.map((s) => this.emit({ type: 'step.skipped', step: s, reason: 'checkpoint' })),
      this.emit({ type: 'run.status', status: 'running' }),
    ];
    queueMicrotask(() => (this.opts.instant ? this.drain() : this.schedule()));
    return out;
  }

  // ---------- simulated endpoints ----------

  kill() {
    if (!this.alive || this.finished || this.waiting === 'approval') return { killed: false, pid: this.pid };
    const pid = this.pid;
    this.flush(this.crash());
    return { killed: true, pid };
  }

  resume() {
    this.flush(this.doResume());
    return { pid: this.pid };
  }

  answer(askId: string, answer: string) {
    if (this.waiting !== 'ask') return;
    this.waiting = null;
    this.send({ type: 'ask.answered', askId, answer });
    this.opts.instant ? this.drain() : this.schedule();
  }

  setLimits(partial: Partial<RunLimits>) {
    this.limits = { ...this.limits, ...partial };
    const exhausted = this.used.credits >= this.limits.maxCredits ? 'credits' : this.used.modelUsd >= this.limits.maxModelUsd ? 'model_usd' : null;
    this.send({ type: 'budget.update', budget: { limits: { ...this.limits }, used: { ...this.used }, exhausted } });
    if (this.waiting === 'budget' && !exhausted) {
      this.waiting = null;
      this.send({ type: 'run.status', status: 'running', note: 'Limit raised' });
      this.schedule();
    }
  }

  decide(approvalId: string, decision: 'approve' | 'reject') {
    const ap = this.approvals.get(approvalId);
    if (!ap) return { ok: false };
    if (decision === 'approve' && this.outbox.has(ap.key)) {
      this.send({ type: 'action.duplicate_blocked', idempotencyKey: ap.key, approvalId, note: 'Idempotency key already in the outbox; nothing was sent' });
      return { ok: true, duplicate: true };
    }
    if (ap.status !== 'pending') return { ok: false };
    ap.status = decision === 'approve' ? 'approved' : 'rejected';
    const evs: RunEvent[] = [{ type: 'approval.decided', approvalId, status: ap.status }];
    if (decision === 'approve') {
      this.outbox.add(ap.key);
      const action: OutboxAction = {
        idempotencyKey: ap.key, runId: this.scenario.runId, approvalId, kind: ap.kind, testMode: true,
        sink: `data/outbox/${ap.key}.${ap.kind === 'send_message' ? 'eml' : 'ics'}`, executedAt: new Date().toISOString(),
        summary: ap.kind === 'send_message' ? 'Message written to the team test inbox' : 'Meeting hold written as .ics (test mode)',
      };
      evs.push({ type: 'action.executed', action });
    }
    this.send(...evs);
    if ([...this.approvals.values()].every((a) => a.status !== 'pending') && !this.finished) {
      this.finished = true;
      this.send(
        { type: 'step.completed', step: 'approval_gate', summary: 'Every approval decided', durationMs: 0 },
        { type: 'step.started', step: 'score_replay', label: 'Score the replay', attempt: 1 },
        { type: 'step.completed', step: 'score_replay', summary: 'Live run, nothing to score', durationMs: 0 },
        { type: 'run.status', status: 'completed', note: 'Finished: every approval decided' },
      );
    }
    return { ok: true, duplicate: false };
  }

  recheck(evidence: Evidence): Evidence {
    return { ...evidence, retrievedAt: new Date().toISOString(), mode: evidence.mode === 'fixture' ? 'fixture' : 'live' };
  }
}
