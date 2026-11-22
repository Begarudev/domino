import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft, Evidence, Target } from '../../shared/types.ts';
import type { ToolContext } from '../runtime/tool.ts';
import { draftGate, steps } from './steps.ts';
import type { Checkpoints } from './steps.ts';

const ev = (id: string, observedAt: string | null, verifiable = true): Evidence => ({
  id, claim: id, source: { provider: 'crustdata', endpoint: '/job/search' }, observedAt, retrievedAt: '2026-11-22T08:00:00Z', mode: 'fixture', verifiable,
});
const draft = (body: string, ids: string[]): Draft => ({
  id: 'dr_1', companyId: 'co_a', personId: 'pe_1', subject: 's', body,
  citations: ids.map((evidenceId, index) => ({ marker: index + 1, evidenceId })), unverifiable: [{ claim: 'Raised a seed round.', reason: 'undated' }],
  checks: [], generator: 'template', verified: true, meeting: { title: 'm', durationMin: 20, proposedSlots: [] },
});
const target = (decider: Target['decider']): Target => ({
  companyId: 'co_a', rank: 1, score: 1, confidence: 0.7, need: 'ML platform engineer', mechanisms: ['TALENT_DRAIN'], netNew: true,
  whyNow: '', whyNowDate: null, decider, path: null, draftId: 'dr_1',
});
const vp = { personId: 'pe_1', name: 'Kavi R', title: 'VP of Engineering', reason: '', evidenceIds: [] };

test('outreach needs two verified, dated, cited facts and a named decider role', () => {
  const evidence = [ev('ev_1', '2026-11-15'), ev('ev_2', '2026-11-12'), ev('ev_3', null), ev('ev_4', '2026-11-01', false)];
  assert.deepEqual(draftGate(draft('Fact one. [1]', ['ev_1']), target(vp), evidence),
    { reason: 'Not drafted: not enough verified evidence (1 of 2)', have: 1, need: 2 });
  // Undated or unverifiable citations do not count; a citation whose marker the verifier stripped does not count.
  assert.equal(draftGate(draft('A. [1] B. [2] C. [3]', ['ev_1', 'ev_3', 'ev_4']), target(vp), evidence)?.have, 1);
  assert.equal(draftGate(draft('A. [1]', ['ev_1', 'ev_2']), target(vp), evidence)?.have, 1);
  assert.equal(draftGate(draft('A. [1] B. [2]', ['ev_1', 'ev_2']), target(null), evidence)?.reason, 'Not drafted: no named decider role found');
  assert.equal(draftGate(draft('A. [1] B. [2]', ['ev_1', 'ev_2']), target(vp), evidence), null);
});

test('a not-drafted message never gets an approval, and the gate does not flip the run to awaiting approval early', async () => {
  const blocked = { ...draft('A. [1]', ['ev_1']), status: 'not_drafted' as const, blockedReason: 'Not drafted: not enough verified evidence (1 of 2)' };
  const ready = { ...draft('A. [1] B. [2]', ['ev_1', 'ev_2']), id: 'dr_2', companyId: 'co_b', status: 'ready' as const };
  const checkpoints = { draft_messages: { drafts: [blocked, ready], targets: [
    { ...target(vp), draftId: null, notDrafted: { reason: blocked.blockedReason, have: 1, need: 2 } },
    { ...target(vp), companyId: 'co_b', draftId: 'dr_2' },
  ] } } as unknown as Checkpoints;
  const result = await steps.approval_gate({ runId: 'run_t' } as ToolContext, checkpoints);
  assert.deepEqual([...new Set(result.output.map(approval => approval.companyId))], ['co_b']);
  assert.ok(!(result.events ?? []).some(event => event.type === 'run.status'), 'approval_gate must not set the run status');
});

test('a draft an older build marked ready is served held when it fails today\'s gate, and passes through when it does not', async () => {
  const { heldPreGate } = await import('../snapshot.ts');
  const evidence = [ev('ev_1', '2026-11-15'), ev('ev_2', '2026-11-12')];
  const oneFact = { ...draft('Fact one. [1]', ['ev_1']), status: 'ready' as const };
  const held = heldPreGate(oneFact, [target(vp)], evidence);
  assert.equal(held?.status, 'held_pre_gate');
  assert.equal(held?.blockedReason, 'Drafted before the evidence gate · not sendable (not enough verified evidence (1 of 2))');
  assert.equal(heldPreGate(draft('A. [1] B. [2]', ['ev_1', 'ev_2']), [target(vp)], evidence), null);
  assert.equal(heldPreGate({ ...oneFact, status: 'not_drafted' }, [target(vp)], evidence), null, 'not drafted stays not drafted');
});
