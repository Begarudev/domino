import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candidate, Opening } from '../../shared/desk.ts';
import type { Evidence } from '../../shared/types.ts';
import { introClaims } from './candidate-steps.ts';

const row = (id: string, observedAt: string): Evidence => ({
  id, claim: id, value: null, observedAt, verifiable: true, source: { provider: 'crustdata', endpoint: '/person/search', field: null, url: null },
} as unknown as Evidence);
const rows = new Map(['ev_aug', 'ev_oct_a', 'ev_oct_b', 'ev_jobs', 'ev_people'].map(id => [id, row(id, '2026-11-22')]));
const candidate = { id: 'cand', displayName: 'Asha K.', consent: { shareHistory: false, shareSkills: false, shareSamples: false, discoverable: true } } as unknown as Candidate;

// Shaped like the live Abacus.AI opening: a summary reason, an August departure that straddles the window start, two
// conclusive October departures (one shares the summary's row), and both replacement checks as clauses.
const abacus = {
  id: 'op', companyId: 'co', companyName: 'Abacus.AI', roleFamily: 'ml_platform', roleTitle: 'ML Platform Engineer', status: 'open',
  predictedAt: '2026-11-22', rule: 'O1', runId: 'run', evidenceIds: [], holdReasons: [],
  reasons: [
    { kind: 'talent_drain', label: '2 people left Oct 2026', date: '2026-10-31', evidenceId: 'ev_oct_b' },
    { kind: 'talent_drain', label: 'Y. left Aug 2026', date: '2026-08-31', evidenceId: 'ev_aug' },
    { kind: 'talent_drain', label: 'P. left Oct 2026', date: '2026-10-31', evidenceId: 'ev_oct_a' },
    { kind: 'talent_drain', label: 'P. left Oct 2026', date: '2026-10-31', evidenceId: 'ev_oct_b' },
    { kind: 'no_replacement', label: 'No post or hire since 1 Oct', date: '2026-11-22', evidenceId: 'ev_jobs' },
  ],
  clauses: [
    { id: 'o1.no_replacement.jobs', text: 'Replacement job search: 0 records', state: 'met', evidenceIds: ['ev_jobs'] },
    { id: 'o1.no_replacement.people', text: 'Replacement person search: 0 records', state: 'met', evidenceIds: ['ev_people'] },
  ],
} as unknown as Opening;

test('the opening claim cites only conclusive departures, never a month that straddles the window start', () => {
  const [opening] = introClaims(abacus, candidate, [], rows);
  assert.deepEqual([...opening.evidenceIds].sort(), ['ev_oct_a', 'ev_oct_b']);
  assert.match(opening.text, /team changes in October 2026/);
});

test('the no-replacement claim names exactly the checks it cites', () => {
  const both = introClaims(abacus, candidate, [], rows)[1];
  assert.match(both.text, /^No ML platform \/ ML infrastructure job post or hire at Abacus\.AI/);
  assert.deepEqual(both.evidenceIds, ['ev_jobs', 'ev_people']);

  const jobsOnly = introClaims({ ...abacus, clauses: abacus.clauses!.slice(0, 1) }, candidate, [], rows)[1];
  assert.match(jobsOnly.text, /^No ML platform \/ ML infrastructure job post at Abacus\.AI/);
  assert.deepEqual(jobsOnly.evidenceIds, ['ev_jobs']);
});
