import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dossier } from './dossier.ts';
import type { RunSnapshot } from '../../shared/types.ts';

const base = (over: Partial<RunSnapshot>): RunSnapshot => ({
  id: 'run_x', request: '', status: 'awaiting_approval', dataMode: 'fixture', llm: 'template', createdAt: '', updatedAt: '',
  intent: null, steps: [], budget: { limits: { maxCredits: 1, maxModelUsd: 1, maxSeconds: 1 }, used: { credits: 0, modelUsd: 0, seconds: 0 }, exhausted: null },
  companies: [], people: [], triggers: [], merges: [], keptApart: [], graph: { nodes: [], edges: [] }, targets: [], drafts: [],
  evidence: [], approvals: [], outbox: [], receipts: [], ledger: [], asks: [], baseline: { hiringFilterCompanyIds: [] },
  engine: { pid: null, alive: false, crashes: 0, resumes: 0 }, replay: null, ...over,
} as RunSnapshot);

test('dossier lists a move once, as role + initial only, and keeps the cross-company chain', () => {
  const snap = base({
    companies: [
      { id: 'co_a', name: 'Orbital Voice', aliases: [], evidenceIds: [] },
      { id: 'co_b', name: 'Kestrel Labs', aliases: [], evidenceIds: [] },
    ],
    people: [{ id: 'pe_1', name: 'Niko Vedral', title: 'Inference Platform Engineer', companyId: 'co_b' }],
    triggers: [
      { id: 'tr_1', companyId: 'co_b', kind: 'hire', date: '2026-11-12', summary: 'hired', relatedCompanyId: 'co_a', personId: 'pe_1', evidenceIds: ['ev_1'] },
      { id: 'tr_2', companyId: 'co_a', kind: 'departure', date: '2026-11-12', summary: 'left', relatedCompanyId: 'co_b', personId: 'pe_1', evidenceIds: ['ev_1'] },
    ],
    graph: { nodes: [], edges: [{ id: 'ed_1', from: 'co_b', to: 'co_a', mechanism: 'TALENT_DRAIN', label: '', rationale: '', confidence: 0.7,
      observedAt: '2026-11-12', evidenceIds: ['ev_1'], order: 0 }] },
  } as Partial<RunSnapshot>);
  const result = dossier(snap, 'co_a')!;
  assert.equal(result.talentFlows.length, 1);
  assert.deepEqual(result.talentFlows[0], { direction: 'out', role: 'Inference Platform Engineer', initial: 'N.', date: '2026-11-12', precision: 'day',
    otherCompanyId: 'co_b', otherCompanyName: 'Kestrel Labs', evidenceIds: ['ev_1'] });
  assert.doesNotMatch(JSON.stringify(result.talentFlows), /Vedral|Niko/);
  assert.equal(result.chains[0].side, 'effect');
  assert.equal(dossier(snap, 'co_missing'), null);
});
