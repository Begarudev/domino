import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../db.ts';
import { ToolContext } from '../runtime/tool.ts';
import { refineIntent, steps } from './steps.ts';
import type { Target } from '../../shared/types.ts';
import { parseIntentRules } from './standin.ts';

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
