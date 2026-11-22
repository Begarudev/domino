import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import type { DataMode, ChaosConfig } from '../../shared/types.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import { NonsenseError } from '../domain/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'domino-tool-test-'));
process.env.DOMINO_DB = join(dir, 'test.db');
process.env.CRUSTDATA_API_KEY = 'mock-crustdata-credential';
const { Store } = await import('../db.ts');
const { BudgetError, canonicalJson, hash, ToolContext } = await import('./tool.ts');
const { cacheStats, exportCache, importCache } = await import('./cache-snapshot.ts');
const store = new Store();
after(() => {
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
const events = (id: string) => store.getEvents(id, 0).map(row => row.event);

test('injected timeout is labelled and retried', async () => {
  const ctx = create('timeout', 'fixture', { timeoutOnce: ['sample'] });
  const result = await ctx.crust(spec, { a: 1, b: 2 }, time, fixture);
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
  const result = await ctx.crust(spec, { a: 1, b: 2 }, time, fixture);
  assert.equal(result.mode, 'fixture');
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.status, row.injected]), [['nonsense', true], ['ok', false]]);
  assert(events(ctx.runId).some(event => event.type === 'tool.retry' && event.reason === 'nonsense' && event.injected));
});

test('a credit ceiling blocks the fetch and marks the run budget_exhausted', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  const ctx = create('budget', 'live', {}, 1);
  await assert.rejects(ctx.crust(spec, { a: 1, b: 2 }, time, fixture), { name: 'Error', message: 'Run reached its credits ceiling' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(store.requireRun(ctx.runId).status, 'budget_exhausted');
  assert.equal(store.budget(ctx.runId).exhausted, 'credits');
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.status, row.credits]), [['budget_blocked', 0]]);
});

test('a limit lowered during an attempt blocks a paid retry', async t => {
  const ctx = create('lower', 'live');
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    store.sql.prepare("UPDATE runs SET limits_json = json_set(limits_json, '$.maxCredits', 1) WHERE id = ?").run(ctx.runId);
    return new Response('', { status: 503 });
  });
  await assert.rejects(ctx.crust(spec, { a: 1, b: 2 }, time, fixture), BudgetError);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => row.status), ['error', 'budget_blocked']);
});

test('live network errors retry three times and replay the matching canonical request from cache', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network unavailable'); });
  const key = hash(spec.path + canonicalJson({ a: 1, b: 2 }));
  store.writeCache(key, 'crustdata', spec.path, canonicalJson({ a: 1, b: 2 }), { rows: ['cached'] });
  const ctx = create('network', 'live');
  const result = await ctx.crust(spec, { b: 2, a: 1 }, time, fixture);
  assert.deepEqual(result, { rows: ['cached'], mode: 'cache' });
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.mode, row.status, row.credits]), [
    ['live', 'error', 0], ['live', 'error', 0], ['live', 'error', 0], ['cache', 'cache_hit', 0],
  ]);
  assert(events(ctx.runId).some(event => event.type === 'tool.fallback' && event.from === 'live' && event.to === 'cache'));
});

test('live charges the reported header and caches a credential-free response', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer mock-crustdata-credential');
    return Response.json({ rows: ['mock-crustdata-credential', 'write to fixture@example.invalid'],
      phone: '+14155550100' }, { headers: { 'X-Credits-Used': '3.25' } });
  });
  const ctx = create('charge', 'live');
  const result = await ctx.crust(spec, { a: 5, b: 8 }, time, fixture);
  assert.equal(result.mode, 'live');
  assert.equal(store.getLedger(ctx.runId)[0].credits, 3.25);
  const cache = store.readCache(hash(spec.path + canonicalJson({ a: 5, b: 8 })));
  assert.deepEqual(cache, { rows: ['[redacted]', 'write to [contact redacted]'] });
});

test('cache miss falls back to fixture with zero credits', async () => {
  const ctx = create('cache-miss', 'cache');
  const result = await ctx.crust(spec, { a: 91, b: 92 }, time, fixture);
  assert.equal(result.mode, 'fixture');
  assert.deepEqual(store.getLedger(ctx.runId).map(row => [row.mode, row.status, row.credits]), [
    ['cache', 'error', 0], ['fixture', 'ok', 0],
  ]);
  assert(events(ctx.runId).some(event => event.type === 'tool.fallback' && event.from === 'cache' && event.to === 'fixture'));
});

test('cache snapshots import missing rows and preserve newer local entries', () => {
  const directory = join(dir, 'snapshots');
  const stats = cacheStats(store);
  assert.equal(stats.cacheRows, 2);
  assert.equal(exportCache(store, directory), 2);
  assert(readdirSync(directory).every(file => /^test_search__[a-f0-9]{16}\.json$/.test(file)));
  const restored = new Store(join(dir, 'restored.db'));
  try {
    assert.equal(importCache(restored, directory), 2);
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
