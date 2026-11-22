// Send-once, shown rather than claimed. On a throwaway fixture server (test mode, nothing leaves the machine):
// approve a message, kill the dispatcher right after the test inbox accepts it (before the sender records it),
// resume, approve again, and print what the receiver holds. `bun run proof:send-once [--intro]`.
import assert from 'node:assert/strict';
import type { IntroRequest } from '../shared/desk.ts';
import type { RunSnapshot } from '../shared/types.ts';
import { Store } from '../server/db.ts';
import { seedOpenings } from '../server/desk/seed-fixture.ts';
import { waitFor, withIsolatedServer } from './smoke.ts';

const intro = process.argv.includes('--intro');

async function proof(base: string, dbPath: string) {
  async function call<T>(path: string, body?: unknown, ok = [200, 201]): Promise<T> {
    const res = await fetch(new URL(path, base), body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert(ok.includes(res.status), `${path} returned HTTP ${res.status}: ${await res.clone().text()}`);
    return res.json() as Promise<T>;
  }
  const run = (id: string) => call<RunSnapshot>(`/api/runs/${id}`);
  const until = (id: string, ready: (snap: RunSnapshot) => boolean) => waitFor(async () => {
    const snap = await run(id);
    assert(!['failed', 'budget_exhausted'].includes(snap.status), `run ${id} reached ${snap.status}`);
    return ready(snap) ? snap : undefined;
  }, 60_000);
  const settled = (snap: RunSnapshot) => snap.status === 'awaiting_approval' && !snap.engine.alive;

  async function outboundRun() {
    const { id } = await call<{ id: string }>('/api/runs', {
      request: 'We sell managed GPU inference. Find AI companies with changes in the last 30 days.',
      dataMode: 'fixture', chaos: { crashAfterDeliver: true },
    });
    const snap = await until(id, settled);
    return { runId: id, approvalId: snap.approvals.find(row => row.kind === 'send_message')!.id };
  }

  async function introRun() {
    // The openings scan's steps are not built yet, so seed the fictional openings scan the desk tests use.
    // A second connection to the running server's DB is safe here: each seed write is its own transaction.
    const store = new Store(dbPath);
    seedOpenings(store);
    store.sql.close();
    const consent = { shareHistory: true, shareSkills: true, shareSamples: true, discoverable: true };
    const { candidateId } = await call<{ candidateId: string }>('/api/candidates',
      { linkedinUrl: 'https://www.linkedin.com/in/fictional-asha', consent });
    await waitFor(async () => ((await call<{ status: string }>(`/api/candidates/${candidateId}`)).status === 'ready' ? true : undefined), 60_000);
    await call(`/api/candidates/${candidateId}/confirm`, {});
    const [opening] = await call<{ id: string }[]>(`/api/candidates/${candidateId}/openings`);
    assert(opening, 'the fixture scan offered no opening for the fixture candidate');
    const created = await call<IntroRequest>(`/api/candidates/${candidateId}/intros`, { openingId: opening.id, chaos: { crashAfterDeliver: true } });
    const row = await waitFor(async () => (await call<IntroRequest[]>(`/api/candidates/${candidateId}/intros`))
      .find(item => item.id === created.id && item.status === 'awaiting_approval'), 60_000);
    return { runId: row.runId!, approvalId: row.approvalId! };
  }

  // 1. A run waiting for approval of one message, with the dispatcher set to die right after delivery.
  const { runId, approvalId } = intro ? await introRun() : await outboundRun();
  const ready = await until(runId, settled);
  const key = ready.approvals.find(row => row.id === approvalId)!.idempotencyKey;
  console.log(`Send-once proof · ${intro ? 'intro' : 'outbound'} run ${runId} · fixture data, test inbox only`);

  const first = await call<{ pending?: boolean }>(`/api/approvals/${approvalId}`, { decision: 'approve' }, [202]);
  assert.equal(first.pending, true);
  const crashed = await run(runId);
  const accepted = crashed.receipts.find(row => row.idempotencyKey === key);
  assert(accepted && crashed.outbox.length === 0);
  console.log(`1. Approve: the test inbox accepted receipt ${key} at ${accepted.receivedAt}; the dispatcher was killed`);
  console.log(`   before the sender recorded it. Receiver: attempts ${accepted.attempts}, deliveries ${accepted.deliveries} · sender outbox: 0`);

  // 2. Resume: the sender retries the pending action; the receiver counts the attempt and recognises the key.
  await call(`/api/runs/${runId}/resume`, {});
  const resumed = await until(runId, snap => snap.outbox.length === 1);
  const retried = resumed.receipts.find(row => row.idempotencyKey === key)!;
  assert.deepEqual([retried.attempts, retried.deliveries], [2, 1]);
  console.log(`2. Resume: the sender retried (attempt ${retried.attempts}); the test inbox already had the key. Already delivered · skipped`);

  // 3. A second human approval is blocked by the same key.
  const again = await call<{ duplicate?: boolean }>(`/api/approvals/${approvalId}`, { decision: 'approve' });
  assert.equal(again.duplicate, true);
  const final = await run(runId);
  const receipt = final.receipts.find(row => row.idempotencyKey === key)!;
  assert.deepEqual([receipt.attempts, receipt.deliveries], [2, 1]);
  assert.equal(final.outbox.filter(row => row.idempotencyKey === key).length, 1);
  console.log('3. Approve again: duplicate blocked, the idempotency key already exists.');
  console.log(`\nReceipt ${key} · Already delivered · skipped · Attempts: ${receipt.attempts} · Deliveries: ${receipt.deliveries}`);
}

if (import.meta.main) await withIsolatedServer(proof);
