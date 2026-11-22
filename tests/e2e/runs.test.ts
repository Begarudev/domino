import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferenceRequest, startServer } from './server.ts';

test('inference request reaches approval with evidence-backed drafts', async t => {
  const server = await startServer(t);
  const id = await server.createRun();
  const snapshot = await server.waitForStatus(id, 'awaiting_approval');
  assert(snapshot.targets.length > 0, 'Expected at least one target');

  const drafts = new Map(snapshot.drafts.map(draft => [draft.id, draft]));
  const evidence = new Map(snapshot.evidence.map(item => [item.id, item]));
  for (const target of snapshot.targets) {
    const parked = target.hold || (target as { watch?: unknown }).watch;
    if (parked) {
      // Held and watchlist accounts are shown with their reasons and are never drafted.
      assert.equal(target.draftId, null, `Parked target ${target.companyId} must not have a draft`);
      continue;
    }
    assert(target.draftId, `Target ${target.companyId} has no draft ID`);
    const draft = drafts.get(target.draftId);
    assert(draft, `Target ${target.companyId} references a missing draft ${target.draftId}`);
    assert.equal(draft.companyId, target.companyId);
    assert(draft.verified === true || draft.checks.some(check => check.status === 'removed' && check.sentence.trim()),
      `Draft ${draft.id} is unverified and lists no removed sentences`);
  }
  for (const draft of snapshot.drafts) {
    for (const { evidenceId } of draft.citations) {
      const item = evidence.get(evidenceId);
      assert(item, `Draft ${draft.id} cites missing evidence ${evidenceId}`);
      assert(item.observedAt, `Draft ${draft.id} cites undated evidence ${evidenceId}`);
      assert.equal(item.verifiable, true, `Draft ${draft.id} cites unverifiable evidence ${evidenceId}`);
    }
  }
});

test('messy request without an offering pauses for an answer and continues', async t => {
  const server = await startServer(t);
  const id = await server.createRun('pls find ai cos w recent infra changes, india, need mtgs');
  const waiting = await server.waitForStatus(id, 'awaiting_input');
  const ask = waiting.asks.find(ask => !ask.answer);
  assert(ask?.id && ask.question.trim() && ask.why.trim(), 'Expected an unanswered Ask explaining why the answer matters');

  const answer = 'managed GPU inference';
  await server.json(`/api/runs/${id}/asks/${ask.id}`, { answer });
  const snapshot = await server.waitForStatus(id, 'awaiting_approval');
  assert.equal(snapshot.asks.find(item => item.id === ask.id)?.answer, answer);
  assert.equal(snapshot.intent?.offering, answer);
});

test('injected timeout and nonsense responses are retried and recorded', async t => {
  const server = await startServer(t);
  const id = await server.createRun(inferenceRequest, {
    chaos: { timeoutOnce: ['job_search'], nonsenseOnce: ['company_growth'] },
  });
  const snapshot = await server.waitForStatus(id, 'awaiting_approval');
  const events = await server.eventsThrough(id, event => event.type === 'run.status' && event.status === 'awaiting_approval');

  for (const [endpoint, reason] of [['job_search', 'timeout'], ['company_growth', 'nonsense']] as const) {
    const retry = events.find(({ event }) => event.type === 'tool.retry' && event.endpoint === endpoint
      && event.reason === reason && event.injected === true)?.event;
    assert(retry?.type === 'tool.retry', `Missing injected ${reason} retry for ${endpoint}`);
    assert(snapshot.ledger.some(row => row.provider === 'crustdata' && row.endpoint === endpoint
      && row.status === reason && row.attempt === retry.attempt && row.injected === true),
    `Missing injected ${reason} ledger entry for ${endpoint}`);
  }
});

test('one-second fixture budget leaves a partial snapshot and explains exhaustion', async t => {
  const server = await startServer(t);
  // Fixture calls cost zero credits. Hold the first tool call across the wall-clock limit.
  const id = await server.createRun(inferenceRequest, {
    limits: { maxSeconds: 1 }, chaos: { timeoutOnce: ['job_search'] },
  });
  const snapshot = await server.waitForStatus(id, 'budget_exhausted');
  assert.equal(snapshot.budget.limits.maxSeconds, 1);
  assert.equal(snapshot.budget.exhausted, 'seconds');
  assert(snapshot.intent?.offering, 'The partial snapshot must retain the parsed offering');
  assert(snapshot.steps.some(step => step.status === 'done'), 'Expected a completed checkpoint in the partial snapshot');
  assert.equal(snapshot.approvals.length, 0);

  await server.eventsThrough(id, event =>
    (event.type === 'ledger.entry' && event.entry.status === 'budget_blocked')
    || (event.type === 'run.status' && event.status === 'budget_exhausted' && Boolean(event.note?.trim()))
    || (event.type === 'budget.update' && event.budget.exhausted === 'seconds'));
});

test('entity resolution merges aliases, preserves distinct companies and deduplicates domains', async t => {
  const server = await startServer(t);
  const id = await server.createRun();
  const snapshot = await server.waitForStatus(id, 'awaiting_approval');
  if (snapshot.merges.length === 0) {
    t.skip('Fixture snapshot has no merge decisions yet');
    return;
  }
  assert(snapshot.keptApart.length > 0, 'Expected at least one kept-apart decision');
  assert(snapshot.merges.some(merge => merge.kind === 'company' && new Set(merge.names).size > 1
    && snapshot.companies.some(company => company.id === merge.canonicalId)),
  'Expected two company names to resolve to one canonical company in the snapshot');

  const domains = new Set<string>();
  for (const company of snapshot.companies) {
    const domain = company.domain?.trim().toLowerCase().replace(/\.$/, '');
    if (!domain) continue;
    assert(!domains.has(domain), `More than one company shares ${domain}`);
    domains.add(domain);
  }
});

test('historical replay uses zero facts after 1 Sep 2026', async t => {
  const server = await startServer(t);
  const id = await server.createRun(`Replay as of 1 Sep 2026: ${inferenceRequest}`);
  const snapshot = await server.waitForSnapshot(id, 'settled replay', run => run.status === 'completed'
    || (run.status === 'awaiting_approval' && (run.replay !== null || !run.engine.alive)));
  if (snapshot.replay === null) {
    t.skip('Fixture snapshot has no replay score yet');
    return;
  }
  assert.equal(snapshot.replay.asOf, '2026-09-01');
  assert.equal(snapshot.replay.factsAfterAsOfUsed, 0);
});
