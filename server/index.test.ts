import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { STEP_ORDER } from '../shared/types.ts';
import type { Evidence, RunSnapshot, StoredEvent } from '../shared/types.ts';
import { waitFor } from '../scripts/smoke.ts';
import { root } from './env.ts';

const dir = mkdtempSync(join(tmpdir(), 'domino-api-test-'));
const dbPath = join(dir, 'test.db');
const outboxPath = join(dir, 'outbox');
const httpTimeout = { timeout: 20_000 };
const requestText = 'We sell managed GPU inference. Find AI companies with changes in the last 30 days.';
let server: ChildProcess;
let base: string;

async function start() {
  server = spawn(process.execPath, ['server/index.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env, DOMINO_PORT: '0', DOMINO_DATA: 'fixture', DOMINO_DB: dbPath, DOMINO_OUTBOX: outboxPath,
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CRUSTDATA_API_KEY: '',
    },
  });
  let banner = '';
  server.stdout!.on('data', bytes => { banner += bytes; });
  base = await waitFor(async () => {
    assert.equal(server.exitCode, null, 'Server exited before opening its port');
    return banner.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }, 5000);
}

async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}

before(start);
after(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

async function http<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(res.ok, `${path} returned HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
const create = (options = {}) => http<{ id: string }>('/api/runs', { request: requestText, ...options });
const get = (id: string) => http<RunSnapshot>(`/api/runs/${id}`);
const waiting = (snap: RunSnapshot) => snap.status === 'awaiting_approval' && !snap.engine.alive;
function state(id: string, when: (snap: RunSnapshot) => boolean) {
  return waitFor(async () => {
    const snap = await get(id);
    assert.notEqual(snap.status, 'failed', snap.steps.find(row => row.status === 'failed')?.step);
    return when(snap) ? snap : undefined;
  }, 15_000);
}

function read<T>(query: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/ev_[0-9a-f]{24,32}\b/g, 'ev_fixture'));
let uninterrupted: RunSnapshot;

test('concurrent approve writes one test-mode message, records the duplicate, and completes all decisions', httpTimeout, async () => {
  const { id } = await create();
  uninterrupted = await state(id, waiting);
  assert(uninterrupted.targets.length > 0);
  const first = uninterrupted.approvals.find(row => row.kind === 'send_message')!;
  const meeting = uninterrupted.approvals.find(row => row.companyId === first.companyId && row.kind === 'book_meeting')!;
  const decisions = await Promise.all([http(`/api/approvals/${first.id}`, { decision: 'approve' }),
    http(`/api/approvals/${first.id}`, { decision: 'approve' })]);
  assert.equal(decisions.filter(result => JSON.stringify(result) === '{"duplicate":true}').length, 1);
  await http(`/api/approvals/${meeting.id}`, { decision: 'approve' });
  for (const approval of uninterrupted.approvals.filter(row => row.id !== first.id && row.id !== meeting.id)) {
    await http(`/api/approvals/${approval.id}`, { decision: 'reject' });
  }
  const snap = await get(id);
  assert.equal(snap.status, 'completed');
  assert.equal(snap.outbox.length, 2);
  assert.equal(readdirSync(outboxPath).length, 2);
  const send = snap.outbox.find(row => row.kind === 'send_message')!;
  const eml = readFileSync(resolve(root, send.sink), 'utf8');
  assert.match(eml, new RegExp(`<test-inbox\\+${send.idempotencyKey}@domino\\.invalid>`));
  assert.match(eml, /X-Domino-Test-Mode: true\r\n/);
  const calendar = snap.outbox.find(row => row.kind === 'book_meeting')!;
  const ics = readFileSync(resolve(root, calendar.sink), 'utf8');
  assert.match(ics, /METHOD:PUBLISH\r\n/);
  assert.match(ics, /STATUS:TENTATIVE\r\n/);
  assert.doesNotMatch(ics, /ATTENDEE|ORGANIZER/);
  const count = read(db => db.prepare("SELECT count(*) AS n FROM events WHERE run_id = ? AND type = 'action.duplicate_blocked'").get(id));
  assert.equal(count?.n, 1);
});

test('SIGKILL and resume reuse exact completed checkpoints and preserve the final output', httpTimeout, async () => {
  const { id } = await create({ chaos: { timeoutOnce: ['company_enrich'] } });
  await state(id, snap => snap.steps.some(step => step.step === 'enrich_companies' && step.status === 'running'));
  const checkpoints = () => read(db => db.prepare(`SELECT step, attempt, output_json FROM steps WHERE run_id = ?
    AND step IN ('parse_request', 'pull_triggers', 'resolve_entities') ORDER BY step`).all(id));
  const before = checkpoints();
  assert(before.every(row => row.output_json));
  assert.equal((await http<{ killed: boolean }>(`/api/runs/${id}/kill`, {})).killed, true);
  await state(id, snap => snap.status === 'crashed');
  await http(`/api/runs/${id}/resume`, {});
  const after = await state(id, waiting);
  assert.deepEqual(checkpoints(), before);
  assert.deepEqual(after.steps.filter(step => step.resumedFromCheckpoint).map(step => step.step), STEP_ORDER.slice(0, 3));
  assert.deepEqual(after.steps.map(step => step.step), [...STEP_ORDER]);
  assert.deepEqual(normalize(after.graph), normalize(uninterrupted.graph));
  assert.deepEqual(normalize(after.targets), normalize(uninterrupted.targets));
  assert.deepEqual(normalize(after.drafts), normalize(uninterrupted.drafts));
  assert.equal(after.outbox.length, 0);
  assert.deepEqual(after.engine, { pid: null, alive: false, crashes: 1, resumes: 1 });
  const rows = read(db => db.prepare(`SELECT type, payload_json FROM events WHERE run_id = ?
    AND type IN ('engine.crashed', 'engine.resumed', 'step.completed')`).all(id));
  assert.equal(rows.filter(row => row.type === 'step.completed').length, STEP_ORDER.length - 1);
  assert.equal(rows.filter(row => row.type === 'engine.resumed').length, 1);
  assert.equal(JSON.parse(rows.find(row => row.type === 'engine.crashed')!.payload_json as string).signal, 'SIGKILL');
});

test('SSE honors both after and Last-Event-ID and streams stored events in order', httpTimeout, async () => {
  const rows = read(db => db.prepare('SELECT seq FROM events WHERE run_id = ? ORDER BY seq LIMIT 5').all(uninterrupted.id));
  const cursor = rows[1].seq as number;
  const response = await fetch(`${base}/api/runs/${uninterrupted.id}/stream?after=${rows[0].seq}`, {
    headers: { 'Last-Event-ID': String(cursor) }, signal: AbortSignal.timeout(5000),
  });
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (buffer.split('\n\n').length < 3) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const stored = buffer.trim().split('\n\n').slice(0, 2).map(frame => {
    const id = Number(frame.match(/^id: (\d+)$/m)?.[1]);
    const event = JSON.parse(frame.match(/^data: (.+)$/m)![1]) as StoredEvent;
    assert.equal(id, event.seq);
    assert.equal(event.runId, uninterrupted.id);
    return event.seq;
  });
  assert.deepEqual(stored, rows.slice(2, 4).map(row => row.seq));
});

test('asks survive a whole server restart and reuse the same question and answer', httpTimeout, async () => {
  const { id } = await create({ request: 'Find AI companies.' });
  const initial = await state(id, snap => snap.status === 'awaiting_input');
  assert.equal(initial.asks.length, 1);
  assert.equal(initial.asks[0].question, 'What do you sell? The cascade rules depend on it.');
  await stop();
  await start();
  await state(id, snap => snap.status === 'crashed');
  await http(`/api/runs/${id}/resume`, {});
  const reasked = await state(id, snap => snap.status === 'awaiting_input');
  assert.equal(reasked.asks.length, 1);
  assert.equal(reasked.asks[0].id, initial.asks[0].id);
  const answer = 'managed GPU inference';
  await http(`/api/runs/${id}/asks/${reasked.asks[0].id}`, { answer });
  const final = await state(id, waiting);
  assert.equal(final.intent?.offering, answer);
  assert.equal(final.asks[0].answer, answer);
  assert.equal(final.engine.crashes, 1);
});

test('lowering the time ceiling aborts a worker waiting for input', httpTimeout, async () => {
  const { id } = await create({ request: 'Find AI companies.' });
  await state(id, snap => snap.status === 'awaiting_input');
  await http(`/api/runs/${id}/limits`, { maxSeconds: 0 });
  const limited = await state(id, snap => snap.status === 'budget_exhausted' && !snap.engine.alive);
  assert.equal(limited.budget.exhausted, 'seconds');
  assert.equal(limited.budget.limits.maxSeconds, 0);
  assert.equal(limited.asks.length, 1);
});

test('replay uses only cutoff evidence for prediction and scores both baselines in the horizon', httpTimeout, async () => {
  const { id } = await create({
    request: 'We sell managed GPU inference. Replay as of 2026-09-01 through 2026-10-01.',
  });
  const scored = await state(id, waiting);
  assert.equal(scored.intent?.runKind, 'replay');
  const replay = scored.replay!;
  assert.equal(replay.factsAfterAsOfUsed, 0);
  assert(replay.domino.hits > 0);
  assert.equal(replay.baselineFirstOrder.predicted, scored.baseline.hiringFilterCompanyIds.length);
  assert(replay.baselineHeadcount.predicted > 0);
  assert(replay.baselineHeadcount.hits < replay.baselineHeadcount.predicted);
  for (const edge of scored.graph.edges) for (const id of edge.evidenceIds) {
    const row = scored.evidence.find(row => row.id === id);
    assert(row?.observedAt && row.observedAt <= replay.asOf);
  }
  assert(scored.evidence.some(row => row.observedAt && row.observedAt > replay.asOf));
});

test('evidence recheck replays the source and adds a fixture ledger entry', httpTimeout, async () => {
  const original = uninterrupted.evidence.find(row => row.source.endpoint === '/job/search')!;
  const result = await http<Evidence>(`/api/evidence/${original.id}/recheck`, {});
  assert.equal(result.id, original.id);
  assert.equal(result.mode, 'fixture');
  assert(result.retrievedAt > original.retrievedAt);
  assert.equal(result.claim, original.claim);
  const checked = await get(uninterrupted.id);
  assert.equal(checked.ledger.at(-1)?.step, 'evidence.recheck');
  assert.equal(checked.ledger.at(-1)?.credits, 0);
  assert.equal(checked.status, 'completed');
});

test('health exposes the cache count and newest fetch time', httpTimeout, async () => {
  const health = await http<{ cacheRows: number; cacheFetchedAt: string | null }>('/api/health');
  const expected = read(db => db.prepare('SELECT count(*) AS cacheRows, max(fetched_at) AS cacheFetchedAt FROM tool_cache').get());
  assert.equal(health.cacheRows, expected?.cacheRows);
  assert.equal(health.cacheFetchedAt, expected?.cacheFetchedAt);
});

test('receiver commits before dispatcher SIGKILL and run resume reconciles only one delivery', httpTimeout, async () => {
  const { id } = await create({ chaos: { crashAfterDeliver: true } });
  const ready = await state(id, waiting);
  const send = ready.approvals.find(approval => approval.kind === 'send_message')!;
  const actionUrl = `/api/approvals/${send.id}`;
  const interrupted = await fetch(base + actionUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"decision":"approve"}',
  });
  assert.equal(interrupted.status, 202);
  assert.equal((await interrupted.json()).pending, true);
  const key = send.idempotencyKey;
  const inbox = () => read(db => db.prepare('SELECT * FROM inbox_received WHERE idempotency_key = ?').all(key));
  const receiverRows = inbox();
  assert.equal(receiverRows.length, 1);
  assert.match(receiverRows[0].payload_json as string, /domino\.invalid/);
  const sender = () => read(db => db.prepare('SELECT status, executed_at FROM outbox WHERE idempotency_key = ?').get(key));
  assert.equal(sender()?.status, 'pending');
  assert.equal(sender()?.executed_at, null);
  assert.equal((await get(id)).outbox.length, 0);
  assert.equal((await get(id)).approvals.find(row => row.id === send.id)?.status, 'pending');

  const resume = await http<{ pid: number }>(`/api/runs/${id}/resume`, {});
  assert(resume.pid > 0);
  const recovered = await state(id, snap => snap.outbox.length === 1);
  assert.equal(recovered.approvals.find(row => row.id === send.id)?.status, 'approved');
  assert.equal(sender()?.status, 'delivered');
  assert.deepEqual(inbox(), receiverRows);
  const rows = read(db => db.prepare(`SELECT payload_json FROM events WHERE run_id = ? AND type = 'delivery.receipt'`).all(id));
  assert.equal(rows.length, 1);
  const receipt = JSON.parse(rows[0].payload_json as string);
  assert.equal(receipt.receipt.status, 'already_delivered');
  assert.equal(receipt.receipt.receivedAt, receiverRows[0].received_at);
  assert.deepEqual(await http(actionUrl, { decision: 'approve' }), { duplicate: true });
});

test('zero seconds stops the worker before its first step or tool call', httpTimeout, async () => {
  const { id } = await create({ limits: { maxSeconds: 0 } });
  const limited = await state(id, snap => snap.status === 'budget_exhausted' && !snap.engine.alive);
  assert.equal(limited.budget.exhausted, 'seconds');
  assert(limited.steps.every(step => step.status === 'pending'));
  assert.equal(limited.ledger.length, 0);
});

test('live runs with unavailable sources finish without any fixture evidence or approvals', httpTimeout, async () => {
  const { id } = await create({ dataMode: 'live' });
  const snap = await state(id, row => row.status === 'completed');
  assert.equal(snap.dataMode, 'live');
  assert.equal(snap.evidence.length, 0);
  assert.equal(snap.triggers.length, 0);
  assert.equal(snap.approvals.length, 0);
  assert(snap.ledger.length > 0 && snap.ledger.every(row => row.mode === 'cache' && row.credits === 0));
  const rows = read(db => db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'tool.fallback'").all(id));
  assert(rows.length > 0 && rows.every(row => JSON.parse(row.payload_json as string).to === 'cache'));
});
