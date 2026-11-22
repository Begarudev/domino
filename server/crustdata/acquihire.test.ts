import assert from 'node:assert/strict';
import test from 'node:test';
import { liveIntent } from '../../scripts/probe-live.ts';
import type { AcquisitionLead, ParseMeta } from '../domain/types.ts';
import { NonsenseError } from '../domain/types.ts';
import { fixtureFor } from './fixtures.ts';
import { acquihireFixtureArticle as article } from './fixtures/news.ts';
import { acquihireCheck, newsAcquihireFetch, newsAcquihireResolve, newsAcquihireSearch } from './news.ts';
import type { AcquihirePair, AcquihireReader } from './news.ts';

const intent = liveIntent;
const pairs: AcquihirePair[] = [{ loser: 'Poolside', hirers: ['NVIDIA'] },
  { loser: 'Abacus.AI', hirers: ['Arcfront', 'Bravebird', 'Patronus AI'] }];
const meta: ParseMeta = { mode: 'live', endpoint: '/web/search/live', asOf: intent.asOf,
  windowDays: intent.windowDays, retrievedAt: '2026-11-22T12:00:00Z' };
const lead: AcquisitionLead = { acquisitionLead: true, loser: 'Poolside', hirer: 'NVIDIA',
  title: article.title, url: article.url, evidenceIds: ['lead-id'] };
const response = (title = article.title, url = article.url, source = 'news') => ({ success: true,
  timestamp: Date.parse(intent.asOf), results: [{ source, title, url, snippet: 'Date-looking snippet 2026-08-21' }] });
const page = (content = '<meta property="article:published_time" content="2026-08-21T09:00:00Z">', extra = {}) =>
  ({ success: true, url: article.url, title: article.title, content, timestamp: 1795348800, ...extra });

test('acqui-hire search builds one first-pair query with a 180-day range and news source', () => {
  assert.equal(newsAcquihireSearch.name, 'news_acquihire_search');
  assert.equal(newsAcquihireSearch.path, '/web/search/live');
  assert.equal(newsAcquihireSearch.method, 'POST');
  assert.deepEqual(newsAcquihireSearch.build({ intent, pairs }), {
    query: '"Poolside" ("NVIDIA") (acquire OR acquires OR acquisition OR acqui-hire OR "to hire" OR license OR licensing)',
    sources: ['news'], start_date: Date.parse('2026-05-26') / 1000, end_date: Date.parse(intent.asOf) / 1000,
  });
  assert.match(JSON.stringify(newsAcquihireSearch.build({ intent, pairs: [pairs[1]] })), /Arcfront.*Bravebird.*Patronus AI/);
  assert.equal(newsAcquihireSearch.estimateCredits(null, { intent, pairs }), 1);
  assert.throws(() => newsAcquihireSearch.build({ intent, pairs: [] }), NonsenseError);
});

test('Poolside-style licence/staff headline is marked acquisitionLead and stays undated', () => {
  const parsed = newsAcquihireSearch.parse(response(), { intent, pairs }, meta);
  assert.equal(parsed.acquisitionLeads?.length, 1);
  assert.deepEqual(parsed.acquisitionLeads![0], { ...lead, evidenceIds: [parsed.evidence[0].id] });
  assert.equal(parsed.evidence[0].observedAt, null);
  assert.equal(parsed.evidence[0].verifiable, false);
  assert.equal(parsed.evidence[0].source.endpoint, 'news_acquihire_search');
  assert.deepEqual(parsed.acquisitions ?? [], []);
  assert.deepEqual(parsed.triggers, []);
});

for (const word of ['acquires', 'acquired', 'acquisition', 'acqui-hire', 'buys', 'absorbs', 'licenses', 'licences', 'hire 109 staff', 'joins', 'joining']) {
  test(`headline classification accepts ${word} when both parties are named`, () => {
    const parsed = newsAcquihireSearch.parse(response(`NVIDIA ${word} Poolside`), { intent, pairs }, meta);
    assert.equal(parsed.acquisitionLeads?.length, 1);
  });
}

test('Abacus negative control, missing hirer, unrelated headlines and snippets never mark acquisitions', () => {
  const abacus = newsAcquihireSearch.parse(response('Abacus.AI launches new features'), { intent, pairs: [pairs[1]] }, meta);
  assert.deepEqual(abacus.acquisitionLeads, []);
  assert.deepEqual(abacus.acquisitions ?? [], []);
  for (const title of ['Poolside acquired by someone else', 'NVIDIA acquires OtherCo', 'Poolside and NVIDIA at AI conference']) {
    assert.equal(newsAcquihireSearch.parse(response(title), { intent, pairs }, meta).acquisitionLeads?.length, 0);
  }
  const empty = newsAcquihireSearch.parse({ success: true, results: [] }, { intent, pairs: [pairs[1]] }, meta);
  assert.deepEqual(empty.evidence, []);
});

test('fetch emits a dated report with the structured acquisition and real provenance', () => {
  const input = { intent, leads: [lead] };
  assert.deepEqual(newsAcquihireFetch.build(input), { urls: [article.url] });
  assert.equal(newsAcquihireFetch.estimateCredits(null, input), 1);
  const parsed = newsAcquihireFetch.parse([page()], input, meta);
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.evidence[0].observedAt, '2026-08-21');
  assert.equal(parsed.evidence[0].verifiable, true);
  assert.equal(parsed.evidence[0].source.endpoint, 'news_acquihire_fetch');
  assert.equal(parsed.evidence[0].source.field, '$.html.meta[article:published_time]');
  assert.equal(parsed.evidence[0].claim, `“${article.title}” (thenextweb.com, 2026-08-21) reports that NVIDIA acquired, licensed or hired the team of Poolside.`);
  assert.deepEqual(parsed.acquisitions, [{ acquirer: 'NVIDIA', acquired: 'Poolside', date: '2026-08-21',
    sourceUrl: article.url, fixtureOnly: false }]);
  assert.deepEqual(parsed.triggers, []);
});

test('publication metadata fallbacks retain their actual provenance', () => {
  const parsed = newsAcquihireFetch.parse([page('<script type="application/ld+json">{"datePublished":"2026-08-21"}</script>')],
    { intent, leads: [lead] }, meta);
  assert.equal(parsed.evidence[0].source.field, '$.html.jsonld.datePublished');
  assert.equal(parsed.acquisitions?.[0].date, '2026-08-21');
});

test('undated pages, retrieval dates and changed headlines never become acquisition events', () => {
  for (const raw of [page('<p>Poolside NVIDIA 2026-08-21</p>'),
    page('<meta name="date" content="2026-08-21">', { title: 'NVIDIA GPU overview' }),
    page('<meta name="date" content="2026-11-23">'), page('<meta name="date" content="2026-05-26">'),
    { success: false, url: null, title: null, content: null }]) {
    const parsed = newsAcquihireFetch.parse([raw], { intent, leads: [lead] }, meta);
    assert.deepEqual(parsed.acquisitions, []);
    assert(!parsed.evidence.some(row => row.verifiable));
    assert.match(parsed.readSummary!, /can't verify date/);
  }
});

test('Google redirect is resolved via one web title query and is never fetched', async () => {
  const redirect = 'https://www.google.com/goto?url=redirect';
  const calls: { name: string; body: unknown }[] = [];
  const read: AcquihireReader = async (spec, input) => {
    const body = spec.build(input);
    calls.push({ name: spec.name, body });
    const raw = spec === newsAcquihireSearch ? response(article.title, redirect)
      : spec === newsAcquihireResolve ? response(article.title, article.url, 'web') : [page()];
    return spec.parse(raw, input, meta);
  };
  const result = await acquihireCheck(intent, [pairs[0]], read);
  assert.deepEqual(calls.map(call => call.name), ['news_acquihire_search', 'news_acquihire_resolve', 'news_acquihire_fetch']);
  assert.deepEqual(calls[1].body, { query: article.title, sources: ['web'] });
  assert.deepEqual(calls[2].body, { urls: [article.url] });
  assert.equal(result.acquisitions.length, 1);
  assert.throws(() => newsAcquihireFetch.build({ intent, leads: [{ ...lead, url: redirect }] }), NonsenseError);
});

test('unresolvable redirects retain their undated evidence and report cannot verify date', async () => {
  const redirect = 'https://www.google.com/goto?url=redirect';
  const calls: string[] = [];
  const read: AcquihireReader = async (spec, input) => {
    calls.push(spec.name);
    assert.notEqual(spec.name, 'news_acquihire_fetch');
    return spec.parse(response(article.title, redirect, spec.name.endsWith('resolve') ? 'web' : 'news'), input, meta);
  };
  const result = await acquihireCheck(intent, [pairs[0]], read);
  assert.equal(calls.length, 2);
  assert.equal(result.evidence.length, 2);
  assert(result.evidence.every(row => row.observedAt === null && !row.verifiable));
  assert.deepEqual(result.acquisitions, []);
  assert.match(result.reason!, /can't verify date/);
});

test('an unrelated web result cannot resolve a redirect into an acquisition', () => {
  const result = newsAcquihireResolve.parse(response('NVIDIA GPUs', 'https://publisher.test/gpu', 'web'), { intent, lead }, meta);
  assert.deepEqual(result.acquisitionLeads, []);
  assert.match(result.readSummary!, /can't verify date/);
  assert.equal(newsAcquihireResolve.estimateCredits(null, { intent, lead }), 1);
});

test('a caller publisher hint must match a search headline and still pass independent HTML verification', async () => {
  const read: AcquihireReader = async (spec, input) => {
    if (spec.name === 'news_acquihire_search') return spec.parse(response(article.title, 'https://www.google.com/goto?url=x'), input, meta);
    if (spec.name === 'news_acquihire_resolve') return spec.parse({ success: true, results: [] }, input, meta);
    assert.deepEqual(spec.build(input), { urls: [article.url] });
    return spec.parse([page()], input, meta);
  };
  const verified = await acquihireCheck(intent, [pairs[0]], read, { publisherHints: [{ title: article.title, url: article.url }] });
  assert.equal(verified.acquisitions.length, 1);
  const unrelated = await acquihireCheck(intent, [pairs[0]], read, { publisherHints: [{ title: 'Unrelated acquisition', url: article.url }] });
  assert.equal(unrelated.acquisitions.length, 0);
  assert.match(unrelated.reason!, /can't verify date/);
});

test('orchestration retains original undated leads when fetch has no publication date', async () => {
  const read: AcquihireReader = async (spec, input) => spec.parse(
    spec.name === 'news_acquihire_search' ? response() : [page('<p>Undated page</p>')], input, meta);
  const result = await acquihireCheck(intent, [pairs[0]], read);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].verifiable, false);
  assert.equal(result.evidence[0].observedAt, null);
  assert.deepEqual(result.acquisitions, []);
  assert.match(result.reason!, /can't verify date/);
});

test('fetch rejects unrequested pages and does not duplicate repeated response pages', () => {
  const parsed = newsAcquihireFetch.parse([page(undefined, { url: 'https://unrequested.test/article' }), page(), page()],
    { intent, leads: [lead] }, meta);
  assert.equal(parsed.acquisitions?.length, 1);
});

test('context-free fixture reader checks Poolside and Abacus, preserving fixture mode and fixtureOnly', async () => {
  const read: AcquihireReader = async (spec, input) => spec.parse(fixtureFor(spec.path, spec.build(input)), input, { ...meta, mode: 'fixture' });
  const result = await acquihireCheck(intent, pairs, read);
  assert.equal(result.acquisitions.length, 1);
  assert.equal(result.acquisitions[0].acquired, 'Poolside');
  assert.equal(result.acquisitions[0].fixtureOnly, true);
  assert(result.evidence.every(row => row.mode === 'fixture'));
  assert(!result.evidence.some(row => String(row.value).includes('Abacus')));
  const resolved = newsAcquihireResolve.parse(fixtureFor(newsAcquihireResolve.name,
    newsAcquihireResolve.build({ intent, lead })), { intent, lead }, { ...meta, mode: 'fixture' });
  assert.equal(resolved.acquisitionLeads?.length, 1);
});

test('helper bounds checks to three pairs and skips replay without invoking any reader', async () => {
  let count = 0;
  const read: AcquihireReader = async () => { count++; return { mentions: [], people: [], evidence: [], triggers: [] }; };
  await acquihireCheck(intent, [pairs[1], pairs[1], pairs[1], pairs[0]], read);
  assert.equal(count, 3);
  const replay = await acquihireCheck({ ...intent, runKind: 'replay' }, pairs, read);
  assert.equal(count, 3);
  assert.deepEqual(replay.acquisitions, []);
  assert.deepEqual(replay.evidence, []);
  assert.match(replay.reason!, /replay/);
});
