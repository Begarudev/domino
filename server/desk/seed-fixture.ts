// A seeded openings scan over fictional companies, shared by the desk tests and the send-once proof's intro mode
// (the openings pipeline's own steps are not built yet, so a fixture scan yields no openings to intro against).
import type { Departure, Opening } from '../../shared/desk.ts';
import type { Evidence } from '../../shared/types.ts';
import type { Store } from '../db.ts';
import { defaultLimits } from '../env.ts';

export const SEED_OPENINGS_RUN = 'run_seed_openings';

export const evidence = (id: string, claim: string, observedAt: string): Evidence => ({
  id, claim, value: claim, observedAt, retrievedAt: '2026-11-22T08:00:00.000Z', mode: 'fixture', verifiable: true,
  source: { provider: 'crustdata', endpoint: '/person/search', recordId: id, field: 'start_date' },
});
export const seedEvidence = [
  evidence('ev_drain_a', 'An ML Platform Engineer started at another employer in Oct 2026.', '2026-10-01'),
  evidence('ev_drain_b', 'A second ML Platform Engineer started at another employer in Oct 2026.', '2026-10-01'),
  evidence('ev_no_post', 'No ML platform job post at Orbitline Fictional since 1 Oct (checked 22 Nov).', '2026-11-22'),
  evidence('ev_held', 'Two inference engineers moved to the acquirer.', '2026-09-01'),
];
export const openings: Opening[] = [{
  id: 'op_orbit_mlp', companyId: 'co_orbit', companyName: 'Orbitline Fictional', roleFamily: 'ml_platform',
  roleTitle: 'ML Platform Engineer', status: 'open', confidence: 0.7, predictedAt: '2026-11-22', rule: 'O1',
  reasons: [
    { kind: 'talent_drain', label: '2 ML Platform Engineers moved on in Oct 2026', date: '2026-10-01', evidenceId: 'ev_drain_a' },
    { kind: 'no_replacement', label: '0 ML platform job posts or hires since 1 Oct', date: '2026-11-22', evidenceId: 'ev_no_post' },
    { kind: 'news', label: 'Replacement window closes by 30 Nov (provisional)', date: null, evidenceId: null },
  ],
  evidenceIds: ['ev_drain_a', 'ev_drain_b', 'ev_no_post'], runId: SEED_OPENINGS_RUN,
}, {
  id: 'op_kestrel_inf', companyId: 'co_kestrel', companyName: 'Kestrel Fictional', roleFamily: 'inference',
  roleTitle: 'Inference Engineer', status: 'held', confidence: 0.5, predictedAt: '2026-11-22', rule: 'O1',
  reasons: [], holdReasons: ['acqui-hire'], evidenceIds: ['ev_held'], runId: SEED_OPENINGS_RUN,
}];
// An opening whose only reason is unsourced: offered, but its intro is never drafted (no verified, dated fact).
const ghost: Opening = {
  id: 'op_ghost_mlp', companyId: 'co_ghost', companyName: 'Ghost Fictional', roleFamily: 'ml_platform', roleTitle: 'ML Platform Engineer',
  status: 'open', predictedAt: '2026-11-22', rule: 'O1', runId: SEED_OPENINGS_RUN, evidenceIds: [],
  reasons: [{ kind: 'talent_drain', label: 'Two ML platform moves reported (unsourced)', date: '2026-10-01', evidenceId: null }],
};
const departures: Departure[] = [
  { id: 'dp_1', companyId: 'co_orbit', role: 'ML Platform Engineer', roleFamily: 'ml_platform', initial: 'R.', date: '2026-10-01',
    precision: 'month', toCompanyId: null, toCompanyName: 'Elsewhere Fictional', evidenceId: 'ev_drain_a' },
  { id: 'dp_2', companyId: 'co_orbit', role: 'ML Platform Engineer', roleFamily: 'ml_platform', initial: 'T.', date: '2026-10-01',
    precision: 'month', toCompanyId: null, toCompanyName: 'Another Fictional', evidenceId: 'ev_drain_b' },
];

/** Writes a completed openings run (one open, one held, one unsourced opening) into the store. */
export function seedOpenings(store: Store) {
  const runId = SEED_OPENINGS_RUN;
  store.createRun(runId, 'seed', 'fixture', 'template', defaultLimits, {}, 'openings');
  store.recordEvent(runId, { type: 'evidence.added', evidence: seedEvidence });
  const outputs = {
    scope_search: { roleFamilies: ['ml_platform'], asOf: '2026-11-22', runKind: 'live', horizonEnd: null, cohort: 'test', assumptions: [] },
    pull_departures: { departures, evidence: [] },
    resolve_departures: { companies: [
      { id: 'co_orbit', name: 'Orbitline Fictional', aliases: [], headcount: 120, evidenceIds: [] },
      { id: 'co_kestrel', name: 'Kestrel Fictional', aliases: [], headcount: 300, evidenceIds: [] },
    ], departures, evidence: [] },
    check_replacements: { replacements: [], staleCompanyIds: [], evidence: [] },
    detect_openings: { openings: [...openings, ghost], funnel: { runId, rule: 'O1', lockedAt: '2026-11-22T08:38:00Z', snapshot: 'fixture', stages: [{ id: 'departures', label: 'Dated departures', count: 2 }] } },
  } as const;
  for (const [step, output] of Object.entries(outputs)) {
    store.setOutput(runId, step as keyof typeof outputs, output);
    store.recordEvent(runId, { type: 'step.completed', step: step as keyof typeof outputs, summary: 'seeded', durationMs: 0 });
  }
  store.recordEvent(runId, { type: 'run.status', status: 'completed' });
}
