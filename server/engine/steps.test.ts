import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import seller from '../../config/seller.json' with { type: 'json' };
import type { Target } from '../../shared/types.ts';
import { companySearchGrowth, fixtureFor, jobSearch, personSearchRecentMoves } from '../crustdata/index.ts';
import { Store } from '../db.ts';
import { parseIntentRules as dataIntent, templateDraft } from '../domain/index.ts';
import type { SellerProfile } from '../domain/types.ts';
import { canonicalJson, hash, ToolContext } from '../runtime/tool.ts';
import { parseIntentRules } from './standin.ts';
import { refineIntent, steps } from './steps.ts';

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

test('Watchlist stays visible and skips decider reads, drafts, and approval of stale drafts', async () => {
  const store = new Store(':memory:');
  const run = 'watch-fixture';
  try {
    store.createRun(run, 'Fixture test', 'fixture', 'template', { maxCredits: 0, maxModelUsd: 0, maxSeconds: 10 }, {});
    const target: Target = {
      companyId: 'co_watch', rank: 1, score: 0.2, confidence: 0.3, need: 'Serving staffing watch',
      mechanisms: ['TALENT_DRAIN'], netNew: true, whyNow: 'Two dated departures', whyNowDate: '2026-11-02',
      decider: null, path: null, draftId: null,
      watch: { reason: '2 of 3 serving departures seen (Nov 2026); the card fires on the 3rd' },
    };
    const checkpoints = {
      parse_request: dataIntent('We sell managed GPU inference.', '2026-11-22'),
      enrich_companies: {
        companies: [{ id: target.companyId, name: 'Watch fixture', aliases: [], evidenceIds: [] }],
        people: [], triggers: [], evidence: [], idMap: {}, merges: [], keptApart: [],
      },
      rank_targets: { targets: [target], baseline: { hiringFilterCompanyIds: [] } },
      warm_paths: [target],
    };
    const deciders = await steps.find_deciders(new ToolContext(store, run, 'find_deciders'), checkpoints);
    assert.deepEqual(deciders.output, { targets: [target], people: [], evidence: [] });
    assert.deepEqual(store.getLedger(run), []);
    const drafted = await steps.draft_messages(new ToolContext(store, run, 'draft_messages'), {
      ...checkpoints, find_deciders: deciders.output,
    });
    assert.deepEqual(drafted.output, { targets: [target], drafts: [] });
    assert.deepEqual(drafted.events, []);
    const staleDraft = templateDraft({ ...target, watch: null }, null, [], seller as SellerProfile);
    const approvals = await steps.approval_gate(new ToolContext(store, run, 'approval_gate'), {
      draft_messages: { targets: [{ ...target, draftId: staleDraft.id }], drafts: [staleDraft] },
    });
    assert.deepEqual(approvals.output, []);
    assert.deepEqual(approvals.events, []);
  } finally {
    store.sql.close();
  }
});

test('pull_triggers reads cursor pages through the cache and records page-specific provenance', async () => {
  const store = new Store(':memory:');
  const run = 'cached-moves-run';
  const priorLimit = process.env.DOMINO_MOVES_PAGES;
  process.env.DOMINO_MOVES_PAGES = '2';
  try {
    const intent = dataIntent('We sell managed GPU inference. Find AI companies in India.', '2026-11-22');
    store.createRun(run, 'Cached sample', 'cache', 'template', { maxCredits: 0, maxModelUsd: 0, maxSeconds: 10 }, {});
    function cache(path: string, body: unknown, raw: unknown) {
      const request = canonicalJson(body);
      store.writeCache(hash(path + request), 'crustdata', path, request, raw);
    }
    cache(jobSearch.path, jobSearch.build({ intent }), { job_listings: [] });
    cache(companySearchGrowth.path, companySearchGrowth.build({ intent }), { companies: [] });
    const moves = personSearchRecentMoves;
    const firstBody = moves.build({ intent });
    const { profiles } = fixtureFor(moves.name, firstBody) as { profiles: { crustdata_person_id: number }[] };
    assert(profiles.length >= 3);
    const cursor = 'opaque+/=page2';
    const third = 'opaque+/=page3';
    cache(moves.path, firstBody, { profiles: [profiles[0]], next_cursor: cursor });
    cache(moves.path, moves.build({ intent, cursor }), { profiles: [profiles[1]], next_cursor: third });
    cache(moves.path, moves.build({ intent, cursor: third }), { profiles: [profiles[2]], next_cursor: null });

    const { output } = await steps.pull_triggers(new ToolContext(store, run, 'pull_triggers'), { parse_request: intent });
    assert.deepEqual(output.triggers.map(trigger => trigger.kind).sort(), ['departure', 'departure', 'hire', 'hire']);
    assert.deepEqual(new Set(output.evidence.map(row => row.source.recordId)),
      new Set(profiles.slice(0, 2).map(profile => String(profile.crustdata_person_id))));
    const second = output.evidence.find(row => row.source.recordId === String(profiles[1].crustdata_person_id));
    assert.deepEqual(store.findEvidence(second!.id)?.source?.input, { intent, cursor });
    const reads = store.getLedger(run).filter(row => row.endpoint === moves.name);
    assert.deepEqual(reads.map(row => [row.status, row.credits]), [['cache_hit', 0], ['cache_hit', 0]]);
  } finally {
    if (priorLimit === undefined) delete process.env.DOMINO_MOVES_PAGES;
    else process.env.DOMINO_MOVES_PAGES = priorLimit;
    store.sql.close();
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
