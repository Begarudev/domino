import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { detectOpenings, drainWindow, groupDepartures, isProvisional, monthInterval, roleFamily } from './openings.ts';
import type { DepartureFact, O1Input } from './openings.ts';

const asOf = '2026-11-22';
let n = 0;
function left(company: string, role: string, end: string, start: string, to: string, extra: Partial<DepartureFact> = {}): DepartureFact {
  n++;
  return { id: 'dp' + n, personKey: 'p' + n, companyId: company, companyName: company, role, roleFamily: roleFamily(role), initial: 'P.',
    left: monthInterval(end), started: monthInterval(start), toCompanyId: to, toCompanyName: to, evidenceId: 'ev' + n, ...extra };
}
function input(departures: DepartureFact[], extra: Partial<O1Input> = {}): O1Input {
  return { asOf, runId: 'run_t', departures, replacements: [], acquisitions: [],
    companies: [{ id: 'Abacus.AI', name: 'Abacus.AI', headcount: 288 }, { id: 'Poolside', name: 'Poolside', headcount: 302 }],
    jobChecks: { 'Abacus.AI': { checkedAt: asOf }, Poolside: { checkedAt: asOf } }, ...extra };
}
const abacus = () => [
  left('Abacus.AI', 'ML Platform Engineer', '2026-10-01T00:00:00', '2026-10-01T00:00:00', 'Arcfront'),
  left('Abacus.AI', 'ML Platform Engineer', '2026-10-01T00:00:00', '2026-11-01T00:00:00', 'Bravebird'),
  left('Abacus.AI', 'Machine Learning Platform Engineer', '2026-08-01T00:00:00', '2026-09-01T00:00:00', 'Patronus AI'),
];

test('role families come from engineering titles only', () => {
  assert.equal(roleFamily('Member of Engineering (Inference)'), 'inference');
  assert.equal(roleFamily('ML Platform Engineer'), 'ml_platform');
  assert.equal(roleFamily('Mid MLOps Engineer'), 'mlops');
  assert.equal(roleFamily('Senior GPU Software Engineer'), 'gpu_llm_infra');
  assert.equal(roleFamily('GPU Logic Design Engineer'), null);
  assert.equal(roleFamily('Business Development - Model Compression & AI Infrastructure'), null);
  assert.equal(roleFamily('Client Serving Contractor'), null);
});

test('month-only dates are intervals checked against the whole 90-day window', () => {
  assert.deepEqual(monthInterval('2026-10-01T00:00:00'), ['2026-10-01', '2026-10-31']);
  assert.equal(drainWindow(monthInterval('2026-10-01'), asOf), 'inside');
  assert.equal(drainWindow(monthInterval('2026-08-01'), asOf), 'straddles');  // window opens 24 Aug
  assert.equal(drainWindow(monthInterval('2026-07-01'), asOf), 'outside');
});

test('Abacus.AI: two settled October departures and no replacement yet -> open, provisional until the window closes', () => {
  const { openings } = detectOpenings(input(abacus()));
  assert.equal(openings.length, 1);
  const [opening] = openings;
  assert.equal(opening.status, 'open');
  assert.equal(opening.roleFamily, 'ml_platform');
  assert.ok(isProvisional(opening));
  assert.equal(opening.windowClosesBy, '2026-11-30');
  assert.match(opening.reasons.find(r => r.kind === 'no_replacement')!.label, /replacement window closes by 30 Nov 2026/);
  assert.match(opening.reasons[0].label, /^2 ML platform \/ ML infrastructure people left Oct 2026 \(to Arcfront, Bravebird\); 1 more/);
  assert.equal(opening.confidence, undefined);
  const clause = (id: string) => opening.clauses!.find(c => c.id === id)!;
  assert.equal(clause('o1.departures').state, 'met');
  assert.match(clause('o1.departures').text, /^2 conclusive ML platform \/ ML infrastructure departures \(Oct, Oct\)/);
  assert.match(clause('o1.departures').detail!, /Machine Learning Platform Engineer, Aug 2026 → Patronus AI: not conclusive, month straddles window start/);
  assert.equal(clause('o1.no_replacement.jobs').state, 'met');
  assert.equal(clause('o1.window').state, 'open');
  assert.match(clause('o1.window').text, /closes by 30 Nov 2026/);
});

test('a settled no-replacement leg is not provisional', () => {
  const { openings } = detectOpenings(input(abacus(), { asOf: '2026-12-05', jobChecks: { 'Abacus.AI': { checkedAt: '2026-12-05' } } }));
  assert.equal(openings[0].status, 'open');
  assert.equal(isProvisional(openings[0]), false);
  assert.equal(openings[0].clauses!.find(c => c.id === 'o1.window')!.state, 'met');
});

test('any dated replacement post or hire for the family means no opening', () => {
  const { openings, skipped } = detectOpenings(input(abacus(), { replacements: [{ companyId: 'Abacus.AI', roleFamily: 'ml_platform', kind: 'job_post',
    date: ['2026-11-05', '2026-11-05'], label: 'posted “Senior ML Platform Engineer” on 5 Nov 2026', evidenceId: 'evj' }] }));
  assert.equal(openings.length, 0);
  assert.match(skipped[0].reason, /Replacement found/);
  // A post for another family does not count.
  const other = detectOpenings(input(abacus(), { replacements: [{ companyId: 'Abacus.AI', roleFamily: 'inference', kind: 'job_post',
    date: ['2026-11-05', '2026-11-05'], label: 'x', evidenceId: 'evk' }] }));
  assert.equal(other.openings[0].status, 'open');
});

test('Poolside: departures to the acquirer of a dated acqui-hire -> Hold, citing the article', () => {
  const departures = [
    left('Poolside', 'Member of Engineering (Inference)', '2026-09-01', '2026-09-01', 'NVIDIA'),
    left('Poolside', 'Member of Engineering (Inference)', '2026-09-01', '2026-09-01', 'NVIDIA'),
  ];
  const { openings } = detectOpenings(input(departures, { acquisitions: [{ acquirer: 'NVIDIA', acquired: 'Poolside', date: '2026-08-21',
    label: '“Nvidia pays Poolside $6bn to license its model factory and hire 109 staff” (thenextweb.com)',
    url: 'https://thenextweb.com/news/nvidia-poolside-6bn-model-factory-licence', evidenceId: 'evnews' }] }));
  assert.equal(openings[0].status, 'held');
  assert.match(openings[0].holdReasons![0], /^Acqui-hire: .*Poolside.*21 Aug 2026/);
  const guard = openings[0].clauses!.find(c => c.id === 'guard.acquihire')!;
  assert.equal(guard.state, 'failed');
  assert.deepEqual(guard.evidenceIds, ['evnews']);
  assert.match(guard.detail!, /company-level; it does not verify either person's move/);
  assert.ok(openings[0].evidenceIds.includes('evnews'));
  // Without the acquisition the same departures are an opening.
  assert.equal(detectOpenings(input(departures)).openings[0].status, 'open');
  // An acquisition by someone else is not a match.
  const elsewhere = detectOpenings(input(departures, { acquisitions: [{ acquirer: 'AMD', acquired: 'Poolside', date: '2026-08-21', label: 'x', url: null, evidenceId: null }] }));
  assert.equal(elsewhere.openings[0].status, 'open');
});

test('straddling months -> Hold; one departure -> Watch', () => {
  const straddle = [left('Poolside', 'Inference Engineer', '2026-08-01', '2026-09-01', 'NVIDIA'),
    left('Poolside', 'Inference Engineer', '2026-10-01', '2026-10-01', 'Meta')];
  assert.deepEqual(detectOpenings(input(straddle)).openings[0].holdReasons, ['Month-only dates cannot settle the 90-day window']);
  const one = detectOpenings(input([left('Poolside', 'Inference Engineer', '2026-10-01', '2026-10-01', 'Meta')])).openings[0];
  assert.equal(one.status, 'watch');
  assert.deepEqual(one.watch && [one.watch.have, one.watch.need], [1, 2]);
});

test('stale or failed job data -> Watch: cannot verify no replacement was posted', () => {
  const stale = detectOpenings(input(abacus(), { jobChecks: { 'Abacus.AI': { checkedAt: '2026-11-01' } } })).openings[0];
  assert.equal(stale.status, 'watch');
  assert.match(stale.watch!.reason!, /can't verify no replacement was posted/);
  assert.equal(detectOpenings(input(abacus(), { jobChecks: { 'Abacus.AI': { checkedAt: null, failed: true } } })).openings[0].status, 'watch');
  // A timed-out person search is "I can't verify", never open.
  const timeout = detectOpenings(input(abacus(), { hireChecks: { 'Abacus.AI': { checkedAt: null, failed: true } } })).openings[0];
  assert.equal(timeout.status, 'watch');
  assert.equal(timeout.clauses!.find(c => c.id === 'o1.no_replacement.people')!.state, 'cant_verify');
  assert.equal(timeout.clauses!.find(c => c.id === 'o1.no_replacement.jobs')!.state, 'met');
});

test('false-drain guards: restructure, >40% of headcount, unknown size, size band, internal moves', () => {
  const restructure = detectOpenings(input(abacus(), { companies: [{ id: 'Abacus.AI', name: 'Abacus.AI', headcount: 288, headcountChange90d: -14.2, headcountEvidenceId: 'evh' }] }));
  assert.match(restructure.openings[0].holdReasons![0], /Possible restructure: headcount down 14\.2% over 90 days/);
  const news = detectOpenings(input(abacus(), { restructures: [{ companyId: 'Abacus.AI', date: '2026-10-15', label: 'Abacus.AI lays off 20% of staff', evidenceId: 'evl' }] }));
  assert.match(news.openings[0].holdReasons![0], /Possible restructure: Abacus\.AI lays off/);
  const tiny = detectOpenings(input(abacus(), { companies: [{ id: 'Abacus.AI', name: 'Abacus.AI', headcount: 6 }] }));
  assert.equal(tiny.openings.length, 0);           // 6 staff is outside 20–5,000
  const nine = Array.from({ length: 9 }, () => left('Abacus.AI', 'ML Platform Engineer', '2026-10-01', '2026-10-01', 'Arcfront'));
  const forty = detectOpenings(input(nine, { companies: [{ id: 'Abacus.AI', name: 'Abacus.AI', headcount: 20 }] }));
  assert.match(forty.openings[0].holdReasons!.join(' '), /40%/);
  const unknown = detectOpenings(input(abacus(), { companies: [] }));
  assert.match(unknown.openings[0].holdReasons!.join(' '), /size unknown/);
  const internal = abacus().map(d => ({ ...d, toCompanyId: 'Abacus.AI' }));
  assert.equal(detectOpenings(input(internal)).openings.length, 0);
});

test('replay: a move counts only once the profile lag has passed, so nothing after the cutoff leaks in', () => {
  const groups = groupDepartures({ asOf: '2026-09-01', profileLagDays: 30, departures: [
    left('Clarifai', 'MLOps Engineer', '2026-07-01', '2026-07-01', 'X'),
    left('Clarifai', 'MLOps Engineer', '2026-07-01', '2026-08-01', 'Y'),   // new start in August is not known by 2 Aug
  ] });
  assert.equal(groups[0].conclusive.length, 1);
});

test('replay scoring: raw counts per arm, family-specific hits for O1, provisional counted separately', async () => {
  const { scoreOpenings } = await import('./openings.ts');
  const { openings } = detectOpenings(input(abacus(), { asOf: '2026-11-22' }));
  const score = scoreOpenings({
    asOf: '2026-11-22', openings, snapshotLabel: 'test',
    universe: [{ id: 'Abacus.AI', name: 'Abacus.AI' }, { id: 'Poolside', name: 'Poolside' }, { id: 'X', name: 'X' }],
    outcomes: [
      { companyId: 'Abacus.AI', roleFamily: 'ml_platform', kind: 'job_post', date: '2026-12-10', title: 'ML Platform Engineer', evidenceId: 'e1' },
      { companyId: 'Poolside', roleFamily: 'inference', kind: 'hire', date: '2026-12-01', title: 'Inference Engineer', evidenceId: 'e2' },
      { companyId: 'X', roleFamily: 'mlops', kind: 'job_post', date: '2027-03-01', title: 'MLOps Engineer', evidenceId: 'e3' },  // after 60 days
    ],
    anyPostIds: ['Poolside', 'X'], headcountIds: [],
  });
  assert.deepEqual([score.domino.predicted, score.domino.hits], [1, 1]);
  assert.deepEqual([score.baselineFirstOrder.predicted, score.baselineFirstOrder.hits], [2, 1]);
  assert.deepEqual([score.baselineHeadcount.predicted, score.baselineHeadcount.hits], [0, 0]);
  assert.equal(score.horizonEnd, '2027-01-21');
  assert.equal(score.factsAfterAsOfUsed, 0);
  assert.match(score.note, /1 openings \(0 settled, 1 provisional; 0 held\)/);
});
