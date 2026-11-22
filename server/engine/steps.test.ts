import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../db.ts';
import { ToolContext } from '../runtime/tool.ts';
import { refineIntent, steps } from './steps.ts';
import type { SourceReadEvent, Target } from '../../shared/types.ts';
import { parseIntentRules } from './standin.ts';
import { recheckSource } from './sources.ts';

test('a held target is visible but never drafted or given an approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-held-test-'));
  const store = new Store(join(dir, 'test.db'));
  try {
    const run = 'held-fixture';
    store.createRun(run, 'Fixture test', 'fixture', 'template', { maxCredits: 0, maxModelUsd: 0, maxSeconds: 10 }, {});
    const target: Target = {
      companyId: 'co_held', rank: 1, score: 0.9, confidence: 0.9, need: 'managed inference', mechanisms: ['TALENT_DRAIN'],
      netNew: true, whyNow: 'Two hiring signals', whyNowDate: '2026-11-02', decider: null, path: null, draftId: null,
      hold: { reasons: ['Shared parent'] },
    };
    const checkpoints = {
      parse_request: parseIntentRules('We sell managed GPU inference.', '2026-11-22'),
      enrich_companies: {
        companies: [{ id: target.companyId, name: 'Held fixture', aliases: [], evidenceIds: [] }], people: [], triggers: [],
        evidence: [], idMap: {}, merges: [], keptApart: [],
      },
      find_deciders: { targets: [target], people: [], evidence: [] },
      warm_paths: [target],
    };
    const drafted = await steps.draft_messages(new ToolContext(store, run, 'draft_messages'), checkpoints);
    assert.deepEqual(drafted.output, { targets: [target], drafts: [] });
    const approvals = await steps.approval_gate(new ToolContext(store, run, 'approval_gate'), {
      draft_messages: drafted.output,
    });
    assert.deepEqual(approvals.output, []);
    assert.deepEqual(approvals.events, []);
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model refinements keep rule search terms and discard an unrequested geography', () => {
  const request = 'We sell managed GPU inference. Find AI companies.';
  const intent = parseIntentRules(request, '2026-11-22');
  const result = refineIntent(intent, request, {
    geography: 'worldwide', signalKeywords: ['inference serving'], deciderTitles: ['Director of ML'],
  });
  assert.equal(result.geography, null);
  assert.equal(result.parsedBy, 'llm');
  assert(result.signalKeywords.includes('inference'));
  assert(result.signalKeywords.includes('inference serving'));
  assert(result.deciderTitles.includes('CTO'));
  assert(result.deciderTitles.includes('Director of ML'));
});

test('pull triggers publishes both fixture news reads, dated article items, and recheckable evidence', async () => {
  const store = new Store(':memory:');
  const run = 'news-fixture';
  try {
    store.createRun(run, 'We sell managed GPU inference.', 'fixture', 'template',
      { maxCredits: 0, maxModelUsd: 0, maxSeconds: 30 }, {});
    const intent = parseIntentRules('We sell managed GPU inference.', '2026-11-22');
    const result = await steps.pull_triggers(new ToolContext(store, run, 'pull_triggers'), { parse_request: intent });
    const reads = store.getEvents(run, 0).flatMap(row => row.event.type === 'source.read' ? [row.event as SourceReadEvent] : []);
    const search = reads.find(row => row.endpoint === 'news_search')!;
    const fetched = reads.find(row => row.endpoint === 'news_fetch')!;
    assert.equal(search.mode, 'fixture');
    assert.equal(search.query, 'Reading news — Crustdata Web Search (news)');
    assert(search.items.length > 0);
    assert(search.items.every(item => item.kind === 'news' && item.date === null));
    assert.match(fetched.query, /^Reading articles — Crustdata Web Fetch \(publication dates\)/);
    assert(fetched.items.some(item => item.kind === 'news' && item.date && item.url));
    assert(result.output.evidence.filter(row => row.source.endpoint.startsWith('news_')).every(row => row.mode === 'fixture'));
    assert(!result.output.triggers.some(trigger => trigger.evidenceIds.some(id =>
      result.output.evidence.find(row => row.id === id)?.source.endpoint.startsWith('news_'))));
    const article = result.output.evidence.find(row => row.source.endpoint === 'news_fetch')!;
    const saved = store.sql.prepare('SELECT json FROM evidence_sources WHERE id = ?').get(article.id)!;
    const source = JSON.parse(saved.json as string);
    const fresh = await recheckSource(new ToolContext(store, run, 'recheck', { recheck: true }), article, source);
    assert.equal(fresh?.id, article.id);
    assert.equal(fresh?.observedAt, article.observedAt);
    assert.equal(fresh?.mode, 'fixture');
  } finally {
    store.sql.close();
  }
});

test('replay skips both news reads entirely and explains the skip', async () => {
  const store = new Store(':memory:');
  const run = 'news-replay';
  try {
    store.createRun(run, 'Replay managed GPU inference.', 'fixture', 'template',
      { maxCredits: 0, maxModelUsd: 0, maxSeconds: 30 }, {});
    const intent = { ...parseIntentRules('We sell managed GPU inference.', '2026-11-22'), runKind: 'replay' as const };
    const result = await steps.pull_triggers(new ToolContext(store, run, 'pull_triggers'), { parse_request: intent });
    assert.match(result.summary, /Skipped news search and article fetch in replay/);
    assert(!store.getLedger(run).some(row => row.endpoint.startsWith('news_')));
    assert(!result.output.evidence.some(row => row.source.endpoint.startsWith('news_')));
    assert(!store.getEvents(run, 0).some(row => row.event.type === 'source.read' && row.event.endpoint.startsWith('news_')));
  } finally {
    store.sql.close();
  }
});
