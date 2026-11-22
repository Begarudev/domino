import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../db.ts';
import { parseIntentRules } from '../domain/intent.ts';
import { ToolContext } from '../runtime/tool.ts';
import { readAcquihireNews } from './acquihire.ts';
import { recheckSource } from './sources.ts';

const pairs = [{ loser: 'Poolside', hirers: ['NVIDIA'] }, { loser: 'Abacus.AI', hirers: ['Arcfront', 'Bravebird'] }];
const intent = parseIntentRules('We sell recruiting for inference engineers.', '2026-11-22');

test('engine acqui-hire adapter publishes fixture evidence and reads, returns acquisitions and supports recheck', async () => {
  const store = new Store(':memory:');
  const run = 'acquihire-fixture';
  try {
    store.createRun(run, 'Check hiring drains', 'fixture', 'template', { maxCredits: 0, maxModelUsd: 0, maxSeconds: 30 }, {});
    const result = await readAcquihireNews(new ToolContext(store, run, 'pull_triggers'), intent, pairs);
    assert.equal(result.acquisitions.length, 1);
    assert.equal(result.acquisitions[0].acquired, 'Poolside');
    assert.equal(result.acquisitions[0].fixtureOnly, true);
    const reads = store.getEvents(run, 0).flatMap(row => row.event.type === 'source.read' ? [row.event] : []);
    assert.deepEqual(reads.map(read => read.endpoint), ['news_acquihire_search', 'news_acquihire_fetch', 'news_acquihire_search']);
    assert(reads[0].items.every(item => item.kind === 'news' && item.date === null));
    assert(reads[1].items.some(item => item.date === '2026-08-21' && item.matched));
    assert(result.evidence.every(row => row.mode === 'fixture'));
    assert.equal(store.getEvidence(run).length, result.evidence.length);
    assert(!store.getEvents(run, 0).some(row => row.event.type === 'trigger.found'));
    const fact = result.evidence.find(row => row.verifiable)!;
    const source = store.sql.prepare('SELECT json FROM evidence_sources WHERE id = ?').get(fact.id)!;
    const rechecked = await recheckSource(new ToolContext(store, run, 'recheck', { recheck: true }), fact, JSON.parse(source.json as string));
    assert.equal(rechecked?.observedAt, '2026-08-21');
    assert.equal(rechecked?.id, fact.id);
    assert.equal(rechecked?.source.endpoint, 'news_acquihire_fetch');
  } finally { store.sql.close(); }
});

test('replay adapter returns an explicit reason without source reads, evidence or spend', async () => {
  const store = new Store(':memory:');
  const run = 'acquihire-replay';
  try {
    store.createRun(run, 'Replay hiring drains', 'fixture', 'template', { maxCredits: 0, maxModelUsd: 0, maxSeconds: 30 }, {});
    const before = store.getEvents(run, 0);
    const result = await readAcquihireNews(new ToolContext(store, run, 'pull_triggers'), { ...intent, runKind: 'replay' }, pairs);
    assert.deepEqual(result.evidence, []);
    assert.deepEqual(result.acquisitions, []);
    assert.match(result.reason!, /replay/);
    assert.deepEqual(store.getLedger(run), []);
    assert.deepEqual(store.getEvents(run, 0), before);
  } finally { store.sql.close(); }
});
