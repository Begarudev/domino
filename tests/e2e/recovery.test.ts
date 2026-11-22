import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { STEP_ORDER } from '../../shared/types.ts';
import type { LedgerEntry, StoredEvent } from '../../shared/types.ts';
import { inferenceRequest, startServer } from './server.ts';

function crustdataHashes(dbPath: string, runId: string) {
  // CONTRACT.md documents request_hash on the ledger table. LedgerEntry omits it from the API.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, request_hash AS hash FROM ledger WHERE run_id = ? AND provider = 'crustdata'`).all(runId);
    return new Map(rows.map(({ id, hash }) => {
      assert(typeof id === 'number' && typeof hash === 'string' && hash, `Crustdata ledger row ${id} has no request hash`);
      return [id, hash];
    }));
  } finally {
    db.close();
  }
}

function assertNoUnrecordedRepeats(before: Map<number, string>, after: Map<number, string>, ledger: LedgerEntry[], events: StoredEvent[]) {
  const previousHashes = new Set(before.values());
  const byId = new Map(ledger.map(entry => [entry.id, entry]));
  const settledAt = new Map(events.flatMap(({ seq, event }) => event.type === 'ledger.entry' ? [[event.entry.id, seq]] : []));
  const crashedAt = events.find(({ event }) => event.type === 'engine.crashed')?.seq;
  const usedRetries = new Set<number>();

  for (const [id, hash] of after) {
    if (before.has(id) || !previousHashes.has(hash)) continue;
    const row = byId.get(id);
    assert(row, `Resumed Crustdata ledger row ${id} for request ${hash} is missing from the snapshot`);

    const previous = ledger.findLast(entry => entry.id < row.id && after.get(entry.id) === hash
      && entry.endpoint === row.endpoint && entry.mode === row.mode && entry.attempt === row.attempt - 1);
    // A worker can die before it emits ledger.entry for the in-flight attempt.
    const previousSeq = previous && (settledAt.get(previous.id) ?? (before.has(previous.id) ? crashedAt : undefined));
    const retry = previous && events.find(({ seq, event }) => seq > (previousSeq ?? Infinity)
      && seq < (settledAt.get(row.id) ?? -Infinity) && !usedRetries.has(seq)
      && event.type === 'tool.retry' && event.endpoint === row.endpoint && event.attempt === previous.attempt
      && (previous.status === event.reason || (previous.status === 'error'
        && ['http_5xx', 'rate_limit', 'network'].includes(event.reason))));
    assert(retry, `Resume repeated Crustdata ${row.endpoint} request ${hash} as attempt ${row.attempt} without a recorded retry`);
    usedRetries.add(retry.seq);
  }
}

test('kill and resume restores checkpoints without repeating Crustdata requests', async t => {
  const server = await startServer(t);
  // Delay the decider lookup to keep the worker alive long enough to kill it after cascade starts.
  const id = await server.createRun(inferenceRequest, { chaos: { timeoutOnce: ['person_deciders'] } });
  const cascade = STEP_ORDER.indexOf('cascade');
  const started = await server.eventsThrough(id, event => event.type === 'step.started' && STEP_ORDER.indexOf(event.step) >= cascade);

  const killed = await server.json<{ killed: boolean }>(`/api/runs/${id}/kill`, {});
  assert.equal(killed.killed, true, 'POST /kill must kill the active worker');
  await server.waitForStatus(id, 'crashed');
  const crashEvents = await server.eventsThrough(id, event => event.type === 'engine.crashed', started.at(-1)!.seq);
  const firstLife = [...started, ...crashEvents];
  const completed = firstLife.flatMap(({ event }) => event.type === 'step.completed' ? [event.step] : []);
  assert(completed.length > 0, 'Expected completed steps before the kill');
  const before = crustdataHashes(server.dbPath, id);
  assert(before.size > 0, 'Expected Crustdata attempts before the kill');

  const resumed = await server.json<{ pid: number }>(`/api/runs/${id}/resume`, {});
  assert(resumed.pid > 0);
  const snapshot = await server.waitForStatus(id, 'awaiting_approval');
  const secondLife = await server.eventsThrough(id, event => event.type === 'run.status' && event.status === 'awaiting_approval',
    crashEvents.at(-1)!.seq);
  assert(secondLife.some(({ event }) => event.type === 'engine.resumed'), 'Missing engine.resumed event');
  const skipped = new Set(secondLife.flatMap(({ event }) => event.type === 'step.skipped' && event.reason === 'checkpoint' ? [event.step] : []));
  for (const step of completed) assert(skipped.has(step), `Resume failed to skip checkpoint ${step}`);

  const after = crustdataHashes(server.dbPath, id);
  assertNoUnrecordedRepeats(before, after, snapshot.ledger, [...firstLife, ...secondLife]);
});

test('approving the same send twice and after restart writes one outbox action', async t => {
  const server = await startServer(t);
  const id = await server.createRun();
  const snapshot = await server.waitForStatus(id, 'awaiting_approval');
  const approval = snapshot.approvals.find(item => item.kind === 'send_message' && item.status === 'pending');
  assert(approval, 'Expected a pending send_message approval');

  const approve = () => server.json<{ duplicate?: boolean }>(`/api/approvals/${approval.id}`, { decision: 'approve' });
  assert.notEqual((await approve()).duplicate, true, 'First approval must execute the action');
  assert.equal((await approve()).duplicate, true, 'Second approval must be blocked as a duplicate');

  const duplicateEvent = (event: StoredEvent['event']) => event.type === 'action.duplicate_blocked'
    && event.approvalId === approval.id && event.idempotencyKey === approval.idempotencyKey;
  const before = await server.eventsThrough(id, duplicateEvent);

  const assertSingleSend = async () => {
    const { outbox } = await server.snapshot(id);
    assert.equal(outbox.length, 1, 'Expected one outbox row');
    const [action] = outbox;
    assert.equal(action.approvalId, approval.id);
    assert.equal(action.idempotencyKey, approval.idempotencyKey);
    assert.equal(action.kind, 'send_message');
    assert.equal(action.testMode, true);
    assert.match(action.sink, /\.eml$/);
    const files = await readdir(server.outboxPath, { withFileTypes: true });
    assert.deepEqual(files.map(file => file.name), [basename(action.sink)], 'Expected one outbox file');
    assert(files[0].isFile());
  };

  await assertSingleSend();
  await server.restart();
  assert.equal((await approve()).duplicate, true, 'The restarted server must block the same approval');
  const after = await server.eventsThrough(id, duplicateEvent, before.at(-1)!.seq);
  await assertSingleSend();
  assert.equal([...before, ...after].filter(({ event }) => event.type === 'action.executed').length, 1,
    'Expected one action.executed event across both servers');
});
