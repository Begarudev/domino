import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { STEP_ORDER } from '../shared/types.ts';
import type { DeliveryReceipt, RunSnapshot } from '../shared/types.ts';
import { root } from '../server/env.ts';

export async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await sleep(75);
  }
  throw new Error('Timed out waiting for DOMINO');
}

async function smoke(base: string) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, base), body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert(response.ok, `${path} returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  const setup = {
    request: 'We sell managed GPU inference. Find AI companies with changes in the last 30 days.',
    dataMode: 'fixture',
  };
  const status = (id: string) => request<RunSnapshot>(`/api/runs/${id}`);
  const waitState = (id: string, ready: (state: RunSnapshot) => boolean) => waitFor(async () => {
    const state = await status(id);
    if (state.status === 'failed' || state.status === 'budget_exhausted') {
      throw new Error(`Run reached ${state.status} at ${state.steps.find(step => step.status === 'failed')?.step ?? 'startup'}`);
    }
    return ready(state) ? state : undefined;
  });
  const waiting = (state: RunSnapshot) => state.status === 'awaiting_approval' && !state.engine.alive;

  const first = await request<{ id: string }>('/api/runs', setup);
  const ready = await waitState(first.id, waiting);
  assert(ready.targets.length > 0 && ready.drafts.every(draft => draft.verified));
  const send = ready.approvals.find(approval => approval.kind === 'send_message')!;
  const meeting = ready.approvals.find(approval => approval.companyId === send.companyId && approval.kind === 'book_meeting')!;
  await request(`/api/approvals/${send.id}`, { decision: 'approve' });
  assert.deepEqual(await request(`/api/approvals/${send.id}`, { decision: 'approve' }), { duplicate: true });
  await request(`/api/approvals/${meeting.id}`, { decision: 'approve' });
  for (const approval of ready.approvals.filter(row => row.id !== send.id && row.id !== meeting.id)) {
    await request(`/api/approvals/${approval.id}`, { decision: 'reject' });
  }
  const completed = await status(first.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outbox.length, 2);
  const eml = completed.outbox.find(row => row.kind === 'send_message')!;
  const ics = completed.outbox.find(row => row.kind === 'book_meeting')!;
  assert.match(readFileSync(resolve(root, eml.sink), 'utf8'), /X-Domino-Test-Mode: true/);
  assert.match(readFileSync(resolve(root, ics.sink), 'utf8'), /METHOD:PUBLISH/);
  console.log(`Fixture run completed. ${completed.targets.length} targets, 1 local message, 1 tentative meeting hold, duplicate approve blocked.`);

  const second = await request<{ id: string }>('/api/runs', {
    ...setup, chaos: { timeoutOnce: ['company_enrich'], crashAfterDeliver: true },
  });
  const preKill = await waitState(second.id, state => state.steps.some(step => step.step === 'enrich_companies' && step.status === 'running'));
  const killed = await request<{ killed: boolean }>(`/api/runs/${second.id}/kill`, {});
  assert.equal(killed.killed, true);
  await waitState(second.id, state => state.status === 'crashed');
  await request(`/api/runs/${second.id}/resume`, {});
  const resumed = await waitState(second.id, waiting);
  const checkpoints = preKill.steps.filter(step => step.status === 'done');
  assert(checkpoints.length > 0);
  for (const before of checkpoints) {
    const after = resumed.steps.find(step => step.step === before.step)!;
    assert.equal(after.status, 'done');
    assert.equal(after.finishedAt, before.finishedAt);
    assert.equal(after.attempt, before.attempt);
    assert.equal(after.resumedFromCheckpoint, true);
  }
  assert.deepEqual(resumed.steps.map(row => row.step), [...STEP_ORDER]);
  assert.deepEqual(resumed.targets.map(row => row.companyId), completed.targets.map(row => row.companyId));
  assert.equal(resumed.outbox.length, 0);
  assert.equal(resumed.engine.crashes, 1);
  assert.equal(resumed.engine.resumes, 1);
  console.log(`SIGKILL recovery complete. ${checkpoints.length} checkpoints reused, ${resumed.steps.length} unique step rows, 0 outbox rows before approval.`);
  const retrySend = resumed.approvals.find(approval => approval.kind === 'send_message')!;
  const interrupted = await request<{ pending: boolean }>(`/api/approvals/${retrySend.id}`, { decision: 'approve' });
  assert.equal(interrupted.pending, true);
  assert.equal((await status(second.id)).outbox.length, 0);
  const recovered = await request<{ receipt: DeliveryReceipt }>(`/api/approvals/${retrySend.id}`, { decision: 'approve' });
  assert.equal(recovered.receipt.status, 'already_delivered');
  assert.equal((await status(second.id)).outbox.length, 1);
  console.log('Dispatcher SIGKILL recovery complete. Test inbox returned already_delivered and the sender recorded one outbox action.');
  console.log(`Ledger totals. First run ${completed.ledger.length} attempts, ${completed.budget.used.credits} credits, $${completed.budget.used.modelUsd.toFixed(6)} USD.`);
  console.log(`Ledger totals. Resumed run ${resumed.ledger.length} attempts, ${resumed.budget.used.credits} credits, $${resumed.budget.used.modelUsd.toFixed(6)} USD.`);
}

/** Starts a fixture-mode DOMINO on a free port with a throwaway DB and outbox, runs `body`, then cleans up. */
export async function withIsolatedServer(body: (base: string, dbPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'domino-smoke-'));
  const dbPath = join(dir, 'smoke.db');
  const server = spawn(process.execPath, ['server/index.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, DOMINO_DB: dbPath, DOMINO_OUTBOX: join(dir, 'outbox'), DOMINO_PORT: '0',
      DOMINO_DATA: 'fixture', CRUSTDATA_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
  });
  let banner = '';
  server.stdout.on('data', data => { banner += data; });
  try {
    const base = await waitFor(async () => {
      assert.equal(server.exitCode, null, 'DOMINO server exited during startup');
      return /http:\/\/127\.0\.0\.1:\d+/.exec(banner)?.[0];
    });
    await body(base, dbPath);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const base = process.env.DOMINO_URL;
  if (base) await smoke(base);
  else await withIsolatedServer(smoke);
}
