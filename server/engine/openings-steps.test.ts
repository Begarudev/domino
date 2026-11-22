import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { detectOpenings, monthInterval, roleFamily } from '../domain/openings.ts';
import type { DepartureFact } from '../domain/openings.ts';
import { buildFunnel } from './openings-steps.ts';

const mk = (company: string, role: string, end: string, start: string, to: string, i: number): DepartureFact => ({
  id: 'd' + i, personKey: 'p' + i, companyId: company, companyName: company, role, roleFamily: roleFamily(role), initial: 'P.',
  left: monthInterval(end), started: monthInterval(start), toCompanyId: to, toCompanyName: to, evidenceId: 'e' + i });

test('funnel stages count down to decisions and show the straddling departure as a struck row, never a name', () => {
  const facts = [
    mk('Abacus.AI', 'ML Platform Engineer', '2026-10-01', '2026-10-01', 'Arcfront', 1),
    mk('Abacus.AI', 'ML Platform Engineer', '2026-10-01', '2026-11-01', 'Bravebird', 2),
    mk('Abacus.AI', 'Machine Learning Platform Engineer', '2026-08-01', '2026-09-01', 'Patronus AI', 3),
    mk('BigCo', 'Inference Engineer', '2026-10-01', '2026-10-01', 'X', 4),
    mk('Old', 'MLOps Engineer', '2026-06-01', '2026-07-01', 'Y', 5),
  ];
  const companies = [{ id: 'Abacus.AI', name: 'Abacus.AI', headcount: 288 }, { id: 'BigCo', name: 'BigCo', headcount: 90_000 }, { id: 'Old', name: 'Old', headcount: 50 }];
  const scope = { roleFamilies: [], asOf: '2026-11-22', runKind: 'live' as const, horizonEnd: null, cohort: '', assumptions: [] };
  const { openings } = detectOpenings({ asOf: scope.asOf, runId: 'r', departures: facts, companies, replacements: [], acquisitions: [],
    jobChecks: { 'Abacus.AI': { checkedAt: scope.asOf } }, hireChecks: { 'Abacus.AI': { checkedAt: scope.asOf } } });
  const funnel = buildFunnel('r', scope, 1410, facts, companies, openings, 'live');
  const count = (id: string) => funnel.stages.find(stage => stage.id === id)!.count;
  assert.deepEqual(['profiles', 'departures', 'window', 'icp', 'groups', 'open', 'provisional', 'held'].map(count), [1410, 5, 4, 3, 1, 0, 1, 0]);
  const rows = funnel.stages.find(stage => stage.id === 'groups')!.rows!;
  assert.ok(rows.some(row => /^P\. Machine Learning Platform Engineer · Abacus\.AI · left Aug 2026 → Patronus AI/.test(row.label) &&
    row.detail === 'not conclusive: month straddles window start'));
  assert.equal(funnel.rule, 'O1');
});
