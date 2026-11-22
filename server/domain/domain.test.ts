import assert from 'node:assert/strict';
import test from 'node:test';
import type { Company, Evidence } from '../../shared/types.ts';
import { buildCascade, filterAsOf, parseIntentRules, rankTargets, resolveEntities, scoreReplay, verifyDraft } from './index.ts';
import type { Claim, MoveTrigger, ResolvedCompany } from './types.ts';

const today = '2026-11-22';
const intent = parseIntentRules('find ai companies, we sell managed inference anywhere', today);
const company = (id: string, name: string, domain: string): Company => ({
  id, name, aliases: [name], domain, headcount: 100, industry: 'Artificial Intelligence', evidenceIds: [],
});
const a = company('co_a', 'Alpha Query', 'alpha-query.ai');
const b = company('co_b', 'Beta Search', 'beta-search.ai');
const subsidiary = company('co_sub', 'Beta Search Research', 'research.beta-search.ai');

function fact(id: string, observedAt: string | null, endpoint = '/job/search', field = '$.job_details.title'): Evidence {
  return { id, observedAt, claim: 'Alpha Query posted an inference role.', source: { provider: 'crustdata', endpoint, field },
    mode: 'fixture', retrievedAt: today + 'T12:00:00Z', verifiable: Boolean(observedAt) };
}
const first = fact('ev_1', '2026-11-05');
const second = fact('ev_2', '2026-11-11');
function move(id: string, date: string, former: string, loser = a, hirer = b, precision: 'day' | 'month' = 'day') {
  const hire = { ...fact('ev_start_' + id, precision === 'day' ? date : null, '/person/search', '$.experience.employment_details.current[0].start_date'),
    value: 'Inference Engineer' };
  const previous = { ...fact('ev_end_' + id, date, '/person/search', '$.experience.employment_details.past[0].end_date'),
    value: former };
  const trigger: MoveTrigger = {
    id: 'tr_' + id, companyId: hirer.id, relatedCompanyId: loser.id, kind: 'hire', personId: 'pe_' + id,
    date, summary: 'An infrastructure employee moved', evidenceIds: [hire.id, previous.id],
    move: { currentTitle: 'Inference Engineer', previousTitle: former, datePrecision: precision },
  };
  return { trigger, evidence: [hire, previous] };
}

function cascadeMoves(rows: ReturnType<typeof move>[], companies: Company[]) {
  const triggers = rows.map(row => row.trigger);
  const evidence = rows.flatMap(row => row.evidence);
  const graph = buildCascade(intent, triggers, companies, evidence);
  return { graph, targets: rankTargets(intent, graph, companies, triggers).targets };
}

test('messy intent extracts offering and India and records unset defaults', () => {
  const parsed = parseIntentRules('pls find ai cos needing gpu infra, we sell managed inference, india, meetings w deciders', today);
  assert.equal(parsed.offering, 'managed inference');
  assert.equal(parsed.geography, 'India');
  assert.equal(parsed.buyerProfile, 'AI companies');
  assert.ok(parsed.signalKeywords.includes('GPU'));
  assert.equal(parsed.windowDays, 30);
  assert.equal(parsed.maxTargets, 5);
  assert.ok(parsed.assumptions.some(line => line.includes('30-day')));
  assert.equal(parseIntentRules('find teams, book us meetings', today).offering, null);
  assert.equal(parseIntentRules('find teams, book us meetings', today).geography, null);
});

test('replay and non-inference offerings set specific dates, titles and signal keywords', () => {
  const parsed = parseIntentRules('replay as of 1 Sep. selling vector DB. find 7 companies in europe in the past month', today);
  assert.deepEqual([parsed.geography, parsed.asOf, parsed.horizonEnd, parsed.windowDays, parsed.maxTargets],
    ['Europe', '2026-09-01', today, 30, 7]);
  assert.ok(parsed.signalKeywords.includes('vector database'));
  assert.ok(parsed.deciderTitles.includes('Head of Data Platform'));
  for (const [offering, signal] of [['LLM Security', 'LLM security'], ['LLMOps', 'observability'],
    ['coding agents', 'coding agent'], ['AI recruiting', 'talent acquisition']]) {
    assert.ok(parseIntentRules('Selling ' + offering, today).signalKeywords.includes(signal));
  }
  const unknown = parseIntentRules('for our Strange Widget', today);
  assert.equal(unknown.offering, 'Strange Widget');
  assert.ok(unknown.assumptions.some(line => /unrecognized/.test(line)));
  assert.equal(parseIntentRules('we sell data infra in the us', today).geography, 'US');
});

test('entity resolution respects strong identity and conflicting namesakes', () => {
  const result = resolveEntities([
    { key: 'job', name: 'Kestrel Labs', domain: 'https://www.kestrel-labs.ai/home', crustdataId: 100, evidenceIds: [] },
    { key: 'growth', name: 'Kestrel Labs Pvt. Ltd.', domain: 'kestrel-labs.ai', crustdataId: '100', evidenceIds: [] },
    { key: 'wrong', name: 'Kestrel Labs', domain: 'kestrel.example', crustdataId: 200, evidenceIds: [] },
    { key: 'orphan', name: 'Kestrel', evidenceIds: [] },
  ], [
    { key: 'p1', name: 'Dia Testperson', title: 'CTO', companyKey: 'job',
      linkedinUrl: 'https://in.linkedin.com/in/dia-testperson/?trk=ignored', pastEmployers: [], evidenceIds: [] },
    { key: 'p2', name: 'Dia Testperson', title: 'CTO', companyKey: 'growth', pastEmployers: [], evidenceIds: [] },
  ]);
  assert.equal(result.idMap.job, result.idMap.growth);
  assert.notEqual(result.idMap.job, result.idMap.wrong);
  assert.notEqual(result.idMap.growth, result.idMap.wrong);
  assert.equal(result.idMap.p1, result.idMap.p2);
  assert.match(result.merges[0].reason, /2 source records.*(?:job|growth).*domain/);
  assert.notEqual(result.idMap.orphan, result.idMap.job);
  assert.notEqual(result.idMap.orphan, result.idMap.wrong);
  assert.ok(result.keptApart.some(row => row.reason.includes('different domains')));
  const repeated = { key: 'same-source-key', name: 'Kestrel Labs', evidenceIds: [] };
  assert.deepEqual(resolveEntities([repeated, repeated], []).merges, []);
});

test('talent drain needs three distinct conclusive hires at the same company and a recent third hire', () => {
  const moves = [
    move('one', '2026-09-20', 'Inference Engineer'),
    move('two', '2026-10-10', 'ML Infrastructure Engineer'),
    move('three', '2026-11-12', 'GPU Engineer'),
  ];
  const triggers = moves.map(row => row.trigger);
  const evidence = moves.flatMap(row => row.evidence);
  assert.equal(buildCascade(intent, triggers, [a, b], evidence.slice(0, 1)).edges.length, 0);
  assert.equal(cascadeMoves(moves.slice(0, 2), [a, b]).graph.edges.length, 0);
  assert.equal(cascadeMoves([moves[0], moves[1], { ...moves[2], trigger: { ...moves[2].trigger,
    personId: moves[0].trigger.personId } }], [a, b]).graph.edges.length, 0);
  assert.equal(cascadeMoves([moves[0], moves[1], move('old', '2026-10-15', 'Inference Engineer')], [a, b]).graph.edges.length, 0);
  const { graph, targets } = cascadeMoves(moves, [a, b]);
  assert.equal(graph.edges[0].mechanism, 'TALENT_DRAIN');
  assert.equal(graph.edges[0].to, a.id);
  assert.match(graph.edges[0].rationale, /Confidence/);
  assert.ok(graph.edges[0].alternative);
  assert.equal(targets[0].netNew, true);
  assert.equal(targets[0].testedClaim, 'serving staffing activity at Alpha Query within 60 days (a dated hire or job post)');
});

test('exactly two dated serving departures produce a capped, non-firing Watchlist account', () => {
  const september = move('sep', '2026-09-17', 'Inference Engineer');
  const october = move('oct', '2026-10-31', 'ML Platform Engineer');
  october.trigger.move = { ...october.trigger.move!, datePrecision: 'month', startInterval: ['2026-10-01', '2026-10-31'] };
  const { graph, targets } = cascadeMoves([september, october], [a, b]);
  assert.ok(!graph.edges.some(edge => edge.mechanism === 'TALENT_DRAIN'));
  assert.equal(targets.length, 1);
  const [watch] = targets;
  assert.equal(watch.watch?.reason, '2 of 3 serving departures seen (Sep 2026, Oct 2026); the card fires on the 3rd');
  assert.ok(watch.confidence > 0 && watch.confidence <= 0.35);
  assert.equal(watch.testedClaim, undefined);
  assert.equal(watch.draftId, null);
  assert.equal(watch.hold, undefined);

  const duplicate = { ...september, trigger: { ...september.trigger, id: 'tr_duplicate' } };
  assert.equal(cascadeMoves([september, duplicate], [a, b]).targets.length, 0);
  const nonServing = move('non-serving', '2026-11-04', 'Account Manager');
  const acquisition: ResolvedCompany = { ...a, acquisitions: [{ acquirer: b.name, acquired: a.name, date: '2026-09-08' }] };
  assert.ok(!cascadeMoves([september, nonServing], [a, b]).targets.some(row => row.watch));
  assert.ok(!cascadeMoves([september, october], [acquisition, b]).targets.some(row => row.watch));
  assert.ok(!cascadeMoves([september, october], [{ ...a, headcount: 5_001 }, b]).targets.some(row => row.watch));

  const november = move('nov', '2026-11-08', 'GPU Engineer');
  const exactOctober = move('oct-exact', '2026-10-29', 'ML Platform Engineer');
  const fired = cascadeMoves([september, exactOctober, november], [a, b]);
  assert.ok(fired.graph.edges.some(edge => edge.mechanism === 'TALENT_DRAIN'));
  assert.ok(fired.targets.every(row => !row.watch));
});

test('same-company and same-root subsidiary moves are held without a talent-drain edge', () => {
  for (const loser of [b, subsidiary]) {
    const rows = ['2026-11-04', '2026-11-11', '2026-11-13'].map((date, index) =>
      move(String(index), date, 'Inference Engineer', loser, b));
    const { graph, targets } = cascadeMoves(rows, [b, subsidiary]);
    assert.equal(graph.edges.length, 0);
    assert.match(targets[0].hold!.reasons.join(' '), /Shared parent or related domains/);
  }
});

test('guarded targets list headcount, identity, title and date uncertainty reasons', () => {
  const dates = ['2026-11-04', '2026-11-11', '2026-11-13'];
  const cases = [
    { company: { ...a, ambiguousIdentity: true } satisfies ResolvedCompany, title: 'Inference Engineer', precision: 'day', expected: /Ambiguous company identity/ },
    { company: a, title: 'Software Engineer', precision: 'day', expected: /unrecognised titles/ },
    { company: a, title: 'Inference Engineer', precision: 'month', expected: /month-only dates/ },
    { company: { ...a, acquisitions: [{ acquirer: b.name, acquired: a.name, date: '2026-11-01' }] } satisfies ResolvedCompany,
      title: 'Inference Engineer', precision: 'day', expected: /Acquisition or acqui-hire/ },
  ] as const;
  for (const scenario of cases) {
    const rows = dates.map((date, index) => move(String(index), date, index === 2 ? scenario.title : 'Inference Engineer',
      scenario.company, b, index === 2 ? scenario.precision : 'day'));
    const { graph, targets } = cascadeMoves(rows, [scenario.company, b]);
    assert.equal(graph.edges.length, 0);
    assert.match(targets[0].hold!.reasons.join(' '), scenario.expected);
  }
  const small = { ...a, headcount: 20 };
  const largeDrain = Array.from({ length: 9 }, (_, i) => move(String(i), '2026-11-09', 'Inference Engineer', small));
  assert.match(cascadeMoves(largeDrain, [small, b]).targets[0].hold!.reasons.join(' '), /more than 40%/);
});

test('whole-month November starts count and hardware or non-engineering roles do not', () => {
  const first = move('month-1', '2026-11-07', 'GPU Software Engineer');
  const second = move('month-2', '2026-11-10', 'Distributed Training Engineer');
  const third = move('month-3', '2026-11-22', 'LLM Infrastructure Engineer');
  third.trigger.move = { ...third.trigger.move!, datePrecision: 'month', startInterval: ['2026-11-01', '2026-11-22'] };
  assert.match(cascadeMoves([first, second, third], [a, b]).graph.edges[0].label, /Nov 2026/);
  for (const title of ['GPU Design Engineer', 'ASIC Engineer', 'RTL Design Engineer', 'Physical Design Engineer',
    'Technical Program Manager', 'Finance Director', 'GPU Account Manager']) {
    const denied = move('no', '2026-11-12', title);
    const { graph, targets } = cascadeMoves([first, second, denied], [a, b]);
    assert.ok(!graph.edges.some(edge => edge.mechanism === 'TALENT_DRAIN'), title);
    assert.ok(!targets.some(target => target.hold), title);
  }
});

test('talent-drain replay scores only serving titles at the loser within 60 days and omits holds', () => {
  const { targets } = cascadeMoves(['2026-11-05', '2026-11-09', '2026-11-13'].map((date, i) =>
    move(String(i), date, 'Inference Engineer')), [a, b]);
  const replay = parseIntentRules('We sell managed inference. Replay as of 2026-09-01', today);
  const target = { ...targets[0], whyNowDate: '2026-08-01' };
  const outcomes = [
    { companyKey: a.id, date: '2026-09-21', kind: 'job_post', summary: 'posted “Growth Strategist”', evidenceIds: [first.id] },
    { companyKey: a.id, date: '2026-10-31', kind: 'hire', summary: 'filled an Inference Engineer role', evidenceIds: [second.id] },
    { companyKey: b.id, date: '2026-09-05', kind: 'hire', summary: 'filled a GPU Engineer role', evidenceIds: [second.id] },
  ] as const;
  const scored = scoreReplay(replay, [target, { ...target, companyId: b.id, hold: { reasons: ['internal'] } }],
    { firstOrder: [], headcount: [] }, outcomes.map(row => ({ ...row, evidenceIds: [...row.evidenceIds] })));
  assert.equal(scored.domino.predicted, 1);
  assert.equal(scored.domino.hits, 1);
  assert.equal(scored.domino.medianLeadDays, 60);
  assert.match(scored.snapshotLabel!, /Not point-in-time: today's Crustdata index.*1 Sep/);
  assert.match(scored.outcomeDefinition!, /within 60 days/);
  assert.equal(scoreReplay(replay, [target], { firstOrder: [], headcount: [] },
    [{ ...outcomes[1], date: '2026-11-01', evidenceIds: [second.id] }]).domino.hits, 0);
});

test('replay removes future and late-profile facts while retaining dated observations at the cutoff', () => {
  const asOf = '2026-09-01';
  const evidence = [
    fact('post', asOf),
    fact('future', '2026-09-02'),
    fact('undated', null),
    fact('late_hire', '2026-08-04', '/person/search', '$.experience.employment_details.current[0].start_date'),
    { ...fact('late_end', '2026-07-31', '/person/search', '$.experience.employment_details.past[0].end_date'), profileRoleStartedAt: '2026-08-25' },
    fact('on_profile_cutoff', '2026-08-02', '/person/search', '$.experience.employment_details.current[0].start_date'),
  ];
  const { kept, dropped } = filterAsOf(evidence, asOf);
  assert.deepEqual(kept.map(row => row.id), ['post', 'on_profile_cutoff']);
  assert.equal(dropped, 4);
});

test('draft verifier removes unsupported claims and keeps valid citations', () => {
  const claims: Claim[] = [
    { n: 1, text: 'Alpha Query posted an inference role on 2026-11-05.', evidenceIds: [first.id],
      numbers: ['2026-11-05'], verifiable: true, recipientCompany: 'Alpha Query' },
    { n: 2, text: 'The company listed its supplier.', evidenceIds: [], numbers: [], verifiable: false, reason: 'It has no date.' },
  ];
  const rendered = verifyDraft({ subject: 'Hello', body: [
    'Hi Dana,', claims[0].text + ' [1] They recently raised $40M.',
    'The company listed its supplier. [2]', 'We posted a role on 2026-11-11. [1]',
    'Delta Group posted a role on 2026-11-05. [1]', 'Your engineers left on 2026-11-05. [1]', 'Would you have 20 minutes to talk?',
  ].join('\n\n') }, claims, [first]);
  assert.match(rendered.body, /inference role on 2026-11-05\. \[1\]/);
  assert.doesNotMatch(rendered.body, /\$40M|supplier|2026-11-11|Delta Group|engineers left/);
  assert.equal(rendered.checks.filter(check => check.status === 'removed').length, 5);
  assert.equal(rendered.unverifiable[0].reason, 'It has no date.');
  assert.deepEqual(rendered.citations, [{ marker: 1, evidenceId: first.id }]);
});

test('placeholder identifiers never merge unrelated companies (live regression: id 0, self-employed, shared hosts)', () => {
  const m = (key: string, name: string, extra: Record<string, unknown> = {}) => ({ key, name, evidenceIds: [], ...extra });
  const result = resolveEntities([
    m('a', 'ENKRE', { crustdataId: 0 }),
    m('b', 'The Hershey Company', { crustdataId: 0 }),
    m('c', 'Self-employed', { crustdataId: 12345 }),
    m('d', 'Hexalia', { crustdataId: 12345, domain: 'linkedin.com' }),
    m('e', 'Hanse', { domain: 'links.sarvam.io' }),
    m('f', 'Sarvam AI', { domain: 'links.sarvam.io' }),
  ], []);
  const names = result.companies.map(company => company.name).sort();
  assert.ok(names.includes('ENKRE') && names.includes('The Hershey Company') && names.includes('Hexalia') && names.includes('Hanse'));
  assert.equal(result.merges.length, 0);
});

test('verifier keeps cited sentences that name a "Pvt. Ltd." company and seller-only logistics', () => {
  const evidence: Evidence[] = [{ id: 'ev_k', claim: 'Kestrel Labs Pvt. Ltd. posted Senior Inference Engineer on 3 Nov.', value: 'Senior Inference Engineer',
    source: { provider: 'crustdata', endpoint: '/job/search', url: 'https://example.com/j' }, observedAt: '2026-11-03',
    retrievedAt: '2026-11-22T08:00:00Z', mode: 'fixture', verifiable: true }];
  const claims: Claim[] = [{ n: 1, text: 'Kestrel Labs Pvt. Ltd. posted Senior Inference Engineer on 3 Nov.', evidenceIds: ['ev_k'], verifiable: true, numbers: ['3 Nov'] } as Claim];
  const result = verifyDraft({ subject: 's', body: 'Kestrel Labs Pvt. Ltd. posted Senior Inference Engineer on 3 Nov. [1] Happy to keep it to 20 minutes.' }, claims, evidence);
  assert.match(result.body, /Kestrel Labs Pvt\. Ltd\. posted Senior Inference Engineer on 3 Nov\./);
  assert.match(result.body, /20 minutes/);
  assert.equal(result.checks.filter(check => check.status === 'removed').length, 0);
});
