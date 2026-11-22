import assert from 'node:assert/strict';
import test from 'node:test';
import type { Company, Evidence, Trigger } from '../../shared/types.ts';
import { buildCascade, filterAsOf, parseIntentRules, rankTargets, resolveEntities, verifyDraft } from './index.ts';
import type { Claim } from './types.ts';

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
const departure = (id: string, row: Evidence, loser: Company, hirer: Company): Trigger => ({
  id: 'tr_' + id, companyId: loser.id, relatedCompanyId: hirer.id, kind: 'departure', personId: 'pe_' + id,
  date: row.observedAt!, summary: 'An infrastructure employee moved', evidenceIds: [row.id],
});

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
  assert.match(result.merges[0].reason, /job.*domain|growth.*domain/);
  assert.ok(result.keptApart.some(row => row.reason.includes('different domains')));
});

test('talent drain needs distinct people and two dated verifiable rows', () => {
  const moves = [departure('one', first, a, b), departure('two', second, a, b)];
  const withoutSecond = buildCascade(intent, moves, [a, b], [first]);
  assert.equal(withoutSecond.edges.length, 0);
  assert.equal(buildCascade(intent, moves, [a, b], [first, { ...second, observedAt: null }]).edges.length, 0);
  assert.equal(buildCascade(intent, [moves[0], { ...moves[1], personId: moves[0].personId }], [a, b], [first, second]).edges.length, 0);
  const graph = buildCascade(intent, moves, [a, b], [first, second]);
  assert.equal(graph.edges[0].mechanism, 'TALENT_DRAIN');
  assert.match(graph.edges[0].rationale, /Confidence/);
  assert.ok(graph.edges[0].alternative);
  assert.equal(rankTargets(intent, graph, [a, b], moves).targets[0].netNew, true);
});

test('same-company and same-root subsidiary moves never fire a talent-drain edge', () => {
  for (const loser of [b, subsidiary]) {
    const internal = [departure('one', first, loser, b), departure('two', second, loser, b)];
    assert.equal(buildCascade(intent, internal, [b, subsidiary], [first, second]).edges.length, 0);
  }
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
    'The company listed its supplier. [2]', 'We posted a role on 2026-11-11. [1]', 'Would you have 20 minutes to talk?',
  ].join('\n\n') }, claims, [first]);
  assert.match(rendered.body, /inference role on 2026-11-05\. \[1\]/);
  assert.doesNotMatch(rendered.body, /\$40M|supplier|2026-11-11/);
  assert.equal(rendered.checks.filter(check => check.status === 'removed').length, 3);
  assert.equal(rendered.unverifiable[0].reason, 'It has no date.');
  assert.deepEqual(rendered.citations, [{ marker: 1, evidenceId: first.id }]);
});
