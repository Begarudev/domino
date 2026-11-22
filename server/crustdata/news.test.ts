import assert from 'node:assert/strict';
import test from 'node:test';
import seller from '../../config/seller.json' with { type: 'json' };
import { liveIntent } from '../../scripts/probe-live.ts';
import type { ParseMeta, SellerProfile } from '../domain/types.ts';
import { NonsenseError } from '../domain/types.ts';
import { fixtureFor } from './fixtures.ts';
import { activeNewsEvents, newsFetch, newsFetchUrls, newsPublisherUrl, newsSearch, publicationDate } from './news.ts';
import type { NewsEvent } from './news.ts';

const intent = liveIntent;
const events: NewsEvent[] = [{ provider: 'Hugging Face', product: 'Text Generation Inference', kind: 'acquired',
  date: '2026-09-03', sourceUrl: 'https://publisher.test/hugging-face', note: 'Configured announcement.' },
{ provider: 'Chroma', product: 'Chroma Cloud', kind: 'shut_down', date: '2026-10-23',
  sourceUrl: 'https://publisher.test/chroma', note: 'Configured change.' }];
const meta: ParseMeta = { mode: 'live', endpoint: newsFetch.path, asOf: intent.asOf,
  windowDays: 30, retrievedAt: '2026-11-22T12:00:00Z' };
const input = { intent, events, urls: events.map(event => event.sourceUrl) };
const page = (content: string, extra = {}) => ({ success: true, url: input.urls[0],
  title: 'Hugging Face announcement', timestamp: 1795348800, content, ...extra });

test('news search builds one deterministic news query and a 90-day Unix-second range', () => {
  assert.equal(newsSearch.path, '/web/search/live');
  assert.equal(newsSearch.method, 'POST');
  assert.deepEqual(newsSearch.build({ intent, events }), {
    query: '("Hugging Face" OR "Chroma") (acquired OR shut down)', sources: ['news'],
    start_date: Date.parse('2026-08-24') / 1000, end_date: Date.parse('2026-11-22') / 1000,
  });
  assert.equal(newsSearch.estimateCredits(null, { intent, events }), 1);
});

test('search results stay undated and unverifiable even with a timestamp and date-looking snippet', () => {
  const url = 'https://www.google.com/goto?url=redirect';
  const result = newsSearch.parse({ success: true, timestamp: Date.parse(intent.asOf), results: [
    { source: 'news', title: 'Hugging Face announcement', url, snippet: 'Published November 21, 2026', date: intent.asOf },
  ] }, { intent, events }, meta);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].observedAt, null);
  assert.equal(result.evidence[0].verifiable, false);
  assert.equal(result.evidence[0].source.endpoint, 'news_search');
  assert.equal(result.evidence[0].source.provider, 'crustdata');
  assert.equal(result.evidence[0].source.url, url);
  assert.equal(result.evidence[0].claim, 'News result: “Hugging Face announcement”');
  assert.deepEqual(result.triggers, []);
});

test('fetch follows the documented top-level array/content contract, caps URLs and estimates per page', () => {
  assert.equal(newsFetch.path, '/web/enrich/live');
  assert.deepEqual(newsFetch.build(input), { urls: input.urls });
  assert.equal(newsFetch.estimateCredits(null, input), 2);
  assert.equal(newsFetch.estimateCredits([page('')], input), 2);
  const urls = Array.from({ length: 15 }, (_, index) => `https://publisher.test/${index}`);
  assert.equal((newsFetch.build({ intent, urls }) as { urls: string[] }).urls.length, 10);
  assert.throws(() => newsFetch.build({ intent, urls: [] }), NonsenseError);
});

test('article:published_time takes precedence and records the publication field, company and no triggers', () => {
  const html = `<meta content='2026-09-03T12:34:56Z' PROPERTY='article:published_time'>
    <script type="application/ld+json">{"datePublished":"2026-10-01"}</script>
    <meta name="date" content="2026-11-01"><time datetime="2026-11-02">Today</time>`;
  const result = newsFetch.parse([page(html)], input, meta);
  const fact = result.evidence[0];
  assert.equal(result.evidence.length, 1);
  assert.equal(fact.observedAt, '2026-09-03');
  assert.equal(fact.verifiable, true);
  assert.equal(fact.source.field, '$.html.meta[article:published_time]');
  assert.equal(fact.source.endpoint, 'news_fetch');
  assert.equal(fact.source.url, input.urls[0]);
  assert.equal(fact.value, 'Hugging Face announcement');
  assert.equal(fact.claim, '“Hugging Face announcement” was published on 2026-09-03 (publisher.test).');
  assert.deepEqual(result.mentions, [{ key: 'displacement:Hugging Face', name: 'Hugging Face', evidenceIds: [fact.id] }]);
  assert.deepEqual(result.triggers, []);
});

test('JSON-LD datePublished handles graph/arrays and outranks generic meta and time', () => {
  const result = publicationDate(`<script type='application/ld+json'>invalid</script>
    <script TYPE='application/ld+json'>[{"@graph":[{"@type":"NewsArticle","datePublished":"2026-09-03T09:00:00+05:30","dateModified":"2026-11-22"}]}]</script>
    <meta name='date' content='2026-11-01'><time datetime='2026-11-02'>Now</time>`);
  assert.deepEqual(result, { day: '2026-09-03', field: '$.html.jsonld.datePublished' });
});

for (const name of ['date', 'pubdate', 'publish-date']) {
  test(`${name} meta is a publication date fallback`, () => {
    assert.deepEqual(publicationDate(`<meta CONTENT="2026-10-23" NAME="${name}">`),
      { day: '2026-10-23', field: `$.html.meta[${name}]` });
  });
}

test('time datetime dates a fetched page', () => {
  const result = newsFetch.parse([page('<time class="published" datetime="2026-09-03T09:30:00Z">Sep 3</time>')], input, meta);
  assert.equal(result.evidence[0].observedAt, '2026-09-03');
  assert.equal(result.evidence[0].source.field, '$.html.time.datetime');
});

test('undated pages create no evidence, mentions or triggers and are counted in the read summary', () => {
  const result = newsFetch.parse([page('<p>Hugging Face: 2026-09-03</p>'),
    page('<script type="application/ld+json">{"dateModified":"2026-11-22"}</script>', { url: input.urls[1] })], input, meta);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.mentions, []);
  assert.deepEqual(result.triggers, []);
  assert.match(result.readSummary!, /2 pages had no publication date; not used/);
});

test('invalid dates, comments, and non-JSON-LD script text cannot date an article', () => {
  assert.equal(publicationDate(`<meta property="article:published_time" content="2026-02-30">
    <!-- <time datetime="2026-09-03">comment</time> -->
    <script>const data = '<meta name="date" content="2026-09-03">';</script>`), null);
  assert.equal(publicationDate('<script type="application/ld+json">{"timestamp":1795348800}</script>'), null);
});

test('Google redirects never reach fetch, including configured links and direct spec calls', () => {
  const redirect = 'https://www.google.com/goto?url=https%3A%2F%2Fpublisher.test';
  const search = newsSearch.parse({ success: true, results: [
    { source: 'news', title: 'Chroma news', url: redirect },
    { source: 'news', title: 'Hugging Face news', url: 'https://another.test/article' },
    { source: 'news', title: 'Unrelated news', url: 'https://other.test/story' },
  ] }, { intent, events }, meta);
  const configured = [...events, { ...events[0], sourceUrl: redirect }];
  assert.deepEqual(newsFetchUrls(configured, search), [...input.urls, 'https://another.test/article']);
  assert.deepEqual(newsFetch.build({ intent, urls: [redirect, input.urls[0]] }), { urls: [input.urls[0]] });
  assert.equal(newsPublisherUrl('https://news.google.com/articles/123'), undefined);
  assert.equal(newsPublisherUrl('https://www.google.co.uk/url?q=123'), undefined);
  assert.equal(newsPublisherUrl('javascript:alert(1)'), undefined);
});

test('only five distinct provider-named search links are added after configured publisher links', () => {
  const results = Array.from({ length: 9 }, (_, index) => ({ source: 'news',
    title: 'Chroma update', url: `https://publisher.test/discovered-${index}` }));
  const batch = newsSearch.parse({ success: true, results: [results[0], ...results] }, { intent, events }, meta);
  assert.deepEqual(newsFetchUrls(events, batch), [...input.urls, ...results.slice(0, 5).map(row => row.url)]);
});

test('failed fetches, unexpected URLs and duplicate response pages cannot add evidence', () => {
  const html = '<meta property="article:published_time" content="2026-09-03">';
  const result = newsFetch.parse([
    { success: false, url: null, title: null, content: null },
    page(html, { url: 'https://unexpected.test/article' }), page(html), page(html),
  ], input, meta);
  assert.equal(result.evidence.length, 1);
  assert.match(result.readSummary!, /1 pages failed to fetch/);
});

test('provider mentions require matching event date and provider name', () => {
  const date = '<meta name="pubdate" content="2026-09-03">';
  assert.equal(newsFetch.parse([page(date, { title: 'Different company' })], input, meta).mentions.length, 0);
  assert.equal(newsFetch.parse([page('<time datetime="2026-09-04">Today</time>')], input, meta).mentions.length, 0);
  const result = newsFetch.parse([page(date + '<p>Hugging Face</p>', { title: 'Announcement' })], input, meta);
  assert.equal(result.mentions[0].key, 'displacement:Hugging Face');
});

test('active events use the 90-day window and fixture-only events stay out of live/cache mode', () => {
  const all = [...events, { ...events[0], provider: 'Fixture', fixtureOnly: true },
    { ...events[0], provider: 'Expired', date: '2026-08-24' }, { ...events[0], provider: 'Future', date: '2026-11-23' }];
  assert.deepEqual(activeNewsEvents(all, intent, 'live'), events);
  assert.deepEqual(activeNewsEvents(all, intent, 'cache'), events);
  assert.equal(activeNewsEvents(all, intent, 'fixture').length, 3);
});

test('news fixtures use real response shapes and preserve fixture evidence mode', () => {
  const fixtureEvents = activeNewsEvents((seller as SellerProfile).displacementEvents, intent, 'fixture');
  const fixtureInput = { intent, events: fixtureEvents };
  const body = newsSearch.build(fixtureInput);
  const searched = newsSearch.parse(fixtureFor(newsSearch.path, body), fixtureInput, { ...meta, mode: 'fixture' });
  assert(searched.evidence.length > 0);
  for (const row of searched.evidence) { assert.equal(row.mode, 'fixture'); assert.equal(row.verifiable, false); }
  const fetchInput = { ...fixtureInput, urls: newsFetchUrls(fixtureEvents, searched) };
  const dated = newsFetch.parse(fixtureFor(newsFetch.path, newsFetch.build(fetchInput)), fetchInput, { ...meta, mode: 'fixture' });
  assert(dated.evidence.length > 0);
  assert(dated.evidence.every(row => row.mode === 'fixture' && row.verifiable));
  const fetched = newsFetch.parse(fixtureFor(newsFetch.path, newsFetch.build(input)), input, { ...meta, mode: 'fixture' });
  // URLs absent from the configured fixture world represent undated publisher homepages.
  assert.equal(fetched.evidence.length, 0);
  assert.match(fetched.readSummary!, /2 pages had no publication date/);
});

test('malformed upstream responses fail validation', () => {
  assert.throws(() => newsSearch.parse({ results: [] }, { intent, events }, meta), NonsenseError);
  assert.throws(() => newsFetch.parse({ results: [] }, input, meta), NonsenseError);
});
