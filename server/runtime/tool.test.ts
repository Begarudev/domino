import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import type { DataMode, ChaosConfig } from '../../shared/types.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import { NonsenseError } from '../domain/types.ts';

import { Store } from '../db.ts';
import { BudgetError, canonicalJson, hash, ToolContext } from './tool.ts';
import type { CrustReadMeta } from './tool.ts';
import { cacheStats, exportCache, importCache } from './cache-snapshot.ts';

const dir = mkdtempSync(join(tmpdir(), 'domino-tool-test-'));
const dbPath = join(dir, 'test.db');
const store = new Store(dbPath);
const mocked = { CRUSTDATA_API_KEY: 'mock-crustdata-credential', DOMINO_CRUST_SPACING_MS: '0' };
const previous = Object.entries(mocked).map(([name]) => [name, process.env[name]] as const);
before(() => Object.assign(process.env, mocked));
after(() => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  store.sql.close();
  rmSync(dir, { recursive: true, force: true });
});

const create = (id: string, mode: DataMode, chaos: ChaosConfig = {}, maxCredits = 20) => {
  store.createRun(id, 'Fixture test', mode, 'template', { maxCredits, maxModelUsd: 1, maxSeconds: 30 }, chaos);
  return new ToolContext(store, id, 'pull_triggers');
};

const spec: EndpointSpec<{ a: number; b: number }, { rows: string[]; mode: DataMode }> = {
  name: 'sample', path: '/test/search', method: 'POST',
  build: input => input,
  parse(raw, _input, meta) {
    const checked = z.object({ rows: z.array(z.string()) }).safeParse(raw);
    if (!checked.success) throw new NonsenseError('Expected a row array');
    return { rows: checked.data.rows, mode: meta.mode };
  },
  estimateCredits: () => 2,
};
const time = { asOf: '2026-11-22', windowDays: 30 };
const fixture = () => ({ rows: ['fixture'] });
const empty = () => ({ rows: [], mode: 'cache' as const });
const noFixture = () => { throw new Error('Fixture should be unreachable outside fixture runs'); };
const events = (id: string) => store.getEvents(id, 0).map(row => row.event);

test('injected timeout is labelled and retried', async () => {
  const ctx = create('timeout', 'fixture', { timeoutOnce: ['sample'] });
  const result = await ctx.crust(spec, { a: 1, b: 2 }, time, fixture, empty);
  assert.deepEqual(result, { rows: ['fixture'], mode: 'fixture' });
  const ledger = store.getLedger(ctx.runId);
  assert.deepEqual(ledger.map(row => [row.status, row.attempt, row.injected, row.credits]), [
    ['timeout', 1, true, 0], ['ok', 2, false, 0],
  ]);
  assert(ledger[0].latencyMs >= 1000 && ledger[0].latencyMs < 5000);
  assert(events(ctx.runId).some(event => event.type === 'tool.retry' && event.reason === 'timeout' && event.injected));
});

test('injected nonsense goes through the endpoint parser then retries', async () => {
  const ctx = create('nonsense', 'fixture', { nonsenseOnce: ['/test/search'] });
  const result = await ctx.crust(spec, { a: 1, b: 2 }, time, fixture, empty);
  assert.equal(result.mode, 'fixture');
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.status, row.injected]), [['nonsense', true], ['ok', false]]);
  assert(events(ctx.runId).some(event => event.type === 'tool.retry' && event.reason === 'nonsense' && event.injected));
});

test('a credit ceiling blocks the fetch and marks the run budget_exhausted', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  const ctx = create('budget', 'live', {}, 1);
  await assert.rejects(ctx.crust(spec, { a: 1, b: 2 }, time, fixture, empty), { name: 'Error', message: 'Run reached its credits ceiling' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(store.requireRun(ctx.runId).status, 'budget_exhausted');
  assert.equal(store.budget(ctx.runId).exhausted, 'credits');
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.status, row.credits]), [['budget_blocked', 0]]);
  const note = store.sql.prepare('SELECT error FROM ledger WHERE run_id = ?').get(ctx.runId) as { error: string };
  assert.match(note.error, /^Blocked before spend · cap credits 1 · would have cost /);
});

test('an expensive live call that times out is not retried (a timeout can still be billed)', async t => {
  process.env.DOMINO_CRUST_TIMEOUT_MS = '60';
  t.after(() => { delete process.env.DOMINO_CRUST_TIMEOUT_MS; });
  const fetch = t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  }));
  const ctx = create('slow-pricey', 'live', {}, 200);
  const pricey = { ...spec, name: 'pricey', path: '/test/pricey', estimateCredits: () => 46 };
  await ctx.crust(pricey, { a: 1, b: 2 }, time, noFixture, empty).catch(() => undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(store.getLedger(ctx.runId).filter(row => row.mode === 'live').map(row => row.status), ['timeout']);
  assert.ok(!events(ctx.runId).some(event => event.type === 'tool.retry'));
});

test('a cheap live call that times out is still retried', async t => {
  process.env.DOMINO_CRUST_TIMEOUT_MS = '60';
  t.after(() => { delete process.env.DOMINO_CRUST_TIMEOUT_MS; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    calls++;
    if (calls > 1) return Promise.resolve(new Response(JSON.stringify({ rows: ['late'] }), { status: 200 }));
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
  });
  const ctx = create('slow-cheap', 'live', {}, 200);
  const result = await ctx.crust(spec, { a: 3, b: 4 }, time, noFixture, empty);
  assert.deepEqual(result.rows, ['late']);
  assert.equal(calls, 2);
});

test('a limit lowered during an attempt blocks a paid retry', async t => {
  const ctx = create('lower', 'live');
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    store.sql.prepare("UPDATE runs SET limits_json = json_set(limits_json, '$.maxCredits', 1) WHERE id = ?").run(ctx.runId);
    return new Response('', { status: 503 });
  });
  await assert.rejects(ctx.crust(spec, { a: 1, b: 2 }, time, fixture, empty), BudgetError);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => row.status), ['error', 'budget_blocked']);
});

test('live network errors retry three times and replay the matching canonical request from cache', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network unavailable'); });
  const key = hash(spec.path + canonicalJson({ a: 1, b: 2 }));
  store.writeCache(key, 'crustdata', spec.path, canonicalJson({ a: 1, b: 2 }), { rows: ['cached'] });
  create('network', 'live');
  const ctx = new ToolContext(store, 'network', 'evidence.recheck', { recheck: true });
  const result = await ctx.crust(spec, { b: 2, a: 1 }, time, fixture, empty);
  assert.deepEqual(result, { rows: ['cached'], mode: 'cache' });
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.mode, row.status, row.credits]), [
    ['live', 'error', 0], ['live', 'error', 0], ['live', 'error', 0], ['cache', 'cache_hit', 0],
  ]);
  assert(events(ctx.runId).some(event => event.type === 'tool.fallback' && event.from === 'live' && event.to === 'cache'));
  assert.match(store.getLedger(ctx.runId)[0].error ?? '', /network unavailable/);
});

test('live charges the reported header and caches a credential-free response', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer mock-crustdata-credential');
    return Response.json({ rows: ['mock-crustdata-credential', 'write to fixture@example.invalid'],
      phone: '+14155550100', total_count: 10 }, { headers: { 'X-Credits-Used': '3.25' } });
  });
  const ctx = create('charge', 'live');
  const observed: CrustReadMeta[] = [];
  const result = await ctx.crust(spec, { a: 5, b: 8 }, time, fixture, empty, read => observed.push(read));
  assert.equal(result.mode, 'live');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].mode, 'live');
  assert.equal(observed[0].totalAvailable, 10);
  assert.equal(store.getLedger(ctx.runId)[0].credits, 3.25);
  const cache = store.readCache(hash(spec.path + canonicalJson({ a: 5, b: 8 })));
  assert.deepEqual(cache, { rows: ['[redacted]', 'write to [contact redacted]'], total_count: 10 });
});

test('rerunning an exact live request uses cache without an outbound call', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const ctx = create('cache-first', 'live');
  const observed: CrustReadMeta[] = [];
  const result = await ctx.crust(spec, { b: 8, a: 5 }, time, noFixture, empty, read => observed.push(read));
  assert.equal(result.mode, 'cache');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].mode, 'cache');
  assert.equal(observed[0].totalAvailable, 10);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.status, row.credits]), [['cache_hit', 0]]);
});

test('cache miss continues with an empty result and no fixture evidence', async () => {
  const ctx = create('cache-miss', 'cache');
  const result = await ctx.crust(spec, { a: 91, b: 92 }, time, noFixture, empty);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.mode, row.status, row.credits]), [
    ['cache', 'error', 0],
  ]);
  assert(events(ctx.runId).some(event => event.type === 'log' &&
    event.message === 'source unavailable, continuing without it'));
});

test('paid nonsense is attempted twice and a live cache miss never imports fixture evidence', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ rows: 'schema mismatch' },
    { headers: { 'X-Credits-Used': '2' } }));
  const ctx = create('paid-nonsense', 'live');
  const result = await ctx.crust(spec, { a: 18, b: 21 }, time, noFixture, empty);
  assert.deepEqual(result.rows, []);
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.status, row.credits]), [
    ['nonsense', 2], ['nonsense', 2], ['error', 0],
  ]);
  const fallback = store.getEvents(ctx.runId, 0).find(row => row.event.type === 'tool.fallback');
  assert.equal(fallback?.event.type, 'tool.fallback');
  assert.equal(fallback.event.to, 'cache');
  assert.equal((fallback.event as typeof fallback.event & { error: string }).error, 'tool returned nonsense: Expected a row array');
});

test('429 honors Retry-After and logs redacted diagnostics', async t => {
  const started: number[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    started.push(Date.now());
    return started.length === 1 ? Response.json({ error: { message: 'Limit hit for mock-crustdata-credential' } },
      { status: 429, headers: { 'Retry-After': '0.35', 'X-Private': 'never persisted' } }) : Response.json({ rows: ['live'] });
  });
  const ctx = create('rate-limit', 'live');
  assert.equal((await ctx.crust(spec, { a: 31, b: 37 }, time, noFixture, empty)).mode, 'live');
  assert(started[1] - started[0] >= 350);
  const [failed] = store.getLedger(ctx.runId);
  assert.equal(failed.error, 'HTTP 429 Limit hit for [redacted]');
  const retry = events(ctx.runId).find(event => event.type === 'tool.retry');
  assert.equal(retry?.type, 'tool.retry');
  assert.equal(retry.reason, 'rate_limit');
  assert(retry.backoffMs >= 350);
  assert.equal((retry as typeof retry & { error: string }).error, failed.error);
  assert(!JSON.stringify(events(ctx.runId)).includes('never persisted'));
});

test('endpoint leases serialize live calls and enforce spacing across database connections', async t => {
  process.env.DOMINO_CRUST_SPACING_MS = '100';
  const starts: number[] = [];
  let inFlight = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    starts.push(Date.now());
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(starts.length === 2 ? 160 : 25);
    inFlight--;
    return Response.json({ rows: ['live'] });
  });
  const another = new Store(dbPath);
  try {
    const first = create('pace-one', 'live');
    create('pace-two', 'live');
    const second = new ToolContext(another, 'pace-two', 'pull_triggers');
    const third = create('pace-three', 'live');
    await Promise.all([first, second, third].map((ctx, index) =>
      ctx.crust(spec, { a: 80, b: 90 + index }, time, noFixture, empty)));
    assert.equal(peak, 1);
    assert.equal(starts.length, 3);
    assert(starts[1] - starts[0] >= 95);
    assert(starts[2] - starts[1] >= 155);
  } finally {
    another.sql.close();
    process.env.DOMINO_CRUST_SPACING_MS = '0';
  }
});

test('cache snapshots import missing rows and preserve newer local entries', () => {
  const directory = join(dir, 'snapshots');
  const stats = cacheStats(store);
  assert(stats.cacheRows >= 2);
  assert.equal(exportCache(store, directory), stats.cacheRows);
  assert(readdirSync(directory).every(file => /^test_search__[a-f0-9]{16}\.json$/.test(file)));
  const restored = new Store(join(dir, 'restored.db'));
  try {
    assert.equal(importCache(restored, directory), stats.cacheRows);
    assert.equal(importCache(restored, directory), 0);
    assert.deepEqual(cacheStats(restored), stats);
    const key = hash(spec.path + canonicalJson({ a: 1, b: 2 }));
    restored.writeCache(key, 'crustdata', spec.path, canonicalJson({ a: 1, b: 2 }), { rows: ['newer'] });
    assert.equal(importCache(restored, directory), 0);
    assert.deepEqual(restored.readCache(key), { rows: ['newer'] });
  } finally {
    restored.sql.close();
  }
});
