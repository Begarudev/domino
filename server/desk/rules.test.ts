import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../db.ts';
import { rulesRegistry, servedFrom } from './rules.ts';

test('servedFrom says a scan replayed the recorded cache, with the time the data was actually read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-served-'));
  const store = new Store(join(dir, 's.db'));
  try {
    store.createRun('run_served', 'scan', 'live', 'template', { maxCredits: 10, maxModelUsd: 1, maxSeconds: 60 }, {}, 'openings');
    store.sql.prepare('INSERT INTO tool_cache (key, provider, endpoint, request_json, response_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('k'.repeat(64), 'crustdata', '/person/search', '{}', '{}', '2026-11-22T08:38:00.000Z');
    const row = store.beginLedger({ runId: 'run_served', step: 'pull_departures', provider: 'crustdata', endpoint: 'person_departures',
      mode: 'cache', status: 'error', attempt: 1, credits: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0, injected: false }, 'k'.repeat(64));
    store.finishLedger({ ...row, status: 'cache_hit' });
    const served = servedFrom(store, 'run_served');
    assert.equal(served.liveCalls, 0);
    assert.equal(served.cacheHits, 1);
    assert.equal(served.label, 'Live Crustdata read 22 Nov, 14:08–14:08 IST · replayed from the recorded cache (0 credits)');
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rules registry lists every rule with thresholds, lock time and counts, even before any run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-rules-'));
  const store = new Store(join(dir, 'r.db'));
  try {
    const cards = rulesRegistry(store);
    assert.deepEqual(cards.map(card => card.id), ['O1', 'R1', 'CONTAGION', 'DISPLACEMENT', 'DIRECT']);
    for (const card of cards) {
      assert.ok(card.statement && card.thresholds.length && card.lockedAt && card.counts.length, card.id);
      assert.ok(card.counts.every(item => Number.isInteger(item.value)));
    }
    assert.match(cards[0].lockedAt, /14:08 IST, after seeing live departure counts and before any replay outcome/);
    // R1 mixes two sources, so each of its counts names its own run (null before any run).
    assert.ok(cards[1].counts.every(item => 'sourceRunId' in item), 'every R1 count names its run');
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
