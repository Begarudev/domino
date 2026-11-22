import { STEP_ORDER } from '../../shared/types.ts';
import type { StepName } from '../../shared/types.ts';
import { now, stepLabels, Store } from '../db.ts';
import { BudgetError, exhaust, ToolContext } from '../runtime/tool.ts';
import { steps } from './steps.ts';
import type { Checkpoints, Outputs } from './steps.ts';

async function runWorker(runId: string) {
  const store = new Store();
  let current: StepName | undefined;
  const deadline = new AbortController();
  const timer = setInterval(() => {
    const budget = store.budget(runId);
    if (budget.exhausted) deadline.abort(new BudgetError(budget.exhausted));
    else if (budget.used.seconds >= budget.limits.maxSeconds) deadline.abort(new BudgetError('seconds'));
  }, 100);
  try {
    const state = store.getSteps(runId);
    const done = state.filter(step => step.status === 'done').map(step => step.step);
    store.transaction(() => {
      const run = store.requireRun(runId);
      if (run.engine_pid !== process.pid) throw new Error('Run belongs to another worker');
      store.recordEvent(runId, { type: 'engine.started', pid: process.pid, resume: run.resumes > 0 });
      if (done.length) {
        store.recordEvent(runId, { type: 'engine.resumed',
          fromStep: STEP_ORDER.find(step => !done.includes(step)) ?? 'score_replay', skipped: done });
      }
      store.recordEvent(runId, { type: 'run.status', status: 'running' });
    });

    const checkpoints: Checkpoints = {};
    const runStep = async <K extends StepName>(step: K) => {
      const old = state.find(row => row.step === step);
      if (old?.status === 'done') {
        checkpoints[step] = store.getOutput<Outputs[K]>(runId, step);
        store.appendEvent(runId, { type: 'step.skipped', step, reason: 'checkpoint' });
        return;
      }
      if (step === 'score_replay' && checkpoints.parse_request?.runKind !== 'replay') {
        store.sql.prepare("UPDATE steps SET status = 'skipped', finished_at = ?, summary = ? WHERE run_id = ? AND step = ?")
          .run(now(), 'Replay scoring applies to historical runs', runId, step);
        return;
      }
      const ctx = new ToolContext(store, runId, step, { signal: deadline.signal });
      ctx.assertTime();
      current = step;
      const started = performance.now();
      store.appendEvent(runId, { type: 'step.started', step, label: stepLabels[step], attempt: (old?.attempt ?? 0) + 1 });
      const result = await steps[step](ctx, checkpoints);
      ctx.assertTime();
      store.transaction(() => {
        store.setOutput(runId, step, result.output);
        for (const event of result.events ?? []) store.recordEvent(runId, event);
        store.recordEvent(runId, { type: 'step.completed', step, summary: result.summary, durationMs: Math.round(performance.now() - started) });
      });
      checkpoints[step] = result.output;
      current = undefined;
    };

    for (const step of STEP_ORDER) await runStep(step);
    store.transaction(() => {
      const pending = store.getApprovals(runId).some(approval => approval.status === 'pending');
      store.sql.prepare('UPDATE runs SET engine_pid = NULL WHERE id = ? AND engine_pid = ?').run(runId, process.pid);
      store.recordEvent(runId, { type: 'run.status', status: pending ? 'awaiting_approval' : 'completed' });
    });
  } catch (error) {
    store.transaction(() => {
      if (store.requireRun(runId).engine_pid !== process.pid) return;
      const budgetError = error instanceof BudgetError;
      const message = budgetError ? error.message : 'The step could not finish';
      if (current) store.recordEvent(runId, { type: 'step.failed', step: current, error: message });
      if (budgetError) {
        if (store.requireRun(runId).status !== 'budget_exhausted') exhaust(store, runId, error.reason);
      } else {
        store.recordEvent(runId, { type: 'run.status', status: 'failed', note: message });
      }
      store.sql.prepare('UPDATE runs SET engine_pid = NULL WHERE id = ? AND engine_pid = ?').run(runId, process.pid);
    });
  } finally {
    clearInterval(timer);
    store.sql.close();
  }
}

if (import.meta.main) {
  const runId = process.env.RUN_ID;
  if (!runId) process.exit(1);
  const parentGone = () => process.exit(1);
  process.on('disconnect', parentGone);
  try {
    await runWorker(runId);
  } catch {
    process.exitCode = 1;
  } finally {
    process.off('disconnect', parentGone);
    if (process.connected) process.disconnect?.();
  }
}
