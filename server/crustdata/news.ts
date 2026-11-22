import { z } from 'zod';
import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { DataMode, Evidence, Intent } from '../../shared/types.ts';
import { containsPhrase, inWindow, isoDay, shiftDays } from '../domain/facts.ts';
import type { AcquisitionEvent, AcquisitionLead, SellerProfile, TriggerBatch } from '../domain/types.ts';
import { emptyBatch, evidenceRow, publicUrl, str, validate } from './common.ts';
import type { EndpointSpec } from './spec.ts';

export type NewsEvent = SellerProfile['displacementEvents'][number];
type SearchInput = { intent: Intent; events: NewsEvent[] };
type FetchInput = { intent: Intent; urls: string[]; events?: NewsEvent[] };
const configuredEvents = (sellerJson as SellerProfile).displacementEvents;
export const NEWS_WINDOW_DAYS = 90;
export const NEWS_FETCH_LIMIT = 10;

const searchResponse = z.object({
  success: z.literal(true),
  results: z.array(z.object({ source: z.string(), title: z.string(), url: z.string() }).passthrough()),
}).passthrough();
const fetchResponse = z.array(z.object({
  success: z.boolean().nullish(), url: str, title: str, content: str,
}).passthrough());

export function activeNewsEvents(events: NewsEvent[], intent: Intent, mode: DataMode): NewsEvent[] {
  return events.filter(event => inWindow(event.date, shiftDays(intent.asOf, -NEWS_WINDOW_DAYS), intent.asOf)
    && (!event.fixtureOnly || mode === 'fixture'));
}

// Google news/search redirect links are leads, not publisher URLs. Never submit them to Fetch.
export function newsPublisherUrl(value: string): string | undefined {
  const url = publicUrl(value);
  if (!url) return;
  const parsed = new URL(url);
  if (/(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com)$/i.test(parsed.hostname)) return;
  return url;
}

export function newsFetchUrls(events: NewsEvent[], search: Pick<TriggerBatch, 'evidence'>): string[] {
  const configured = [...new Set(events.flatMap(event => newsPublisherUrl(event.sourceUrl) ?? []))];
  const discovered = [...new Set(search.evidence.flatMap(row => {
    const title = typeof row.value === 'string' ? row.value : '';
    const url = row.source.url && newsPublisherUrl(row.source.url);
    return url && !configured.includes(url) && events.some(event => containsPhrase(title, event.provider)) ? [url] : [];
  }))].slice(0, 5);
  return [...configured, ...discovered].slice(0, NEWS_FETCH_LIMIT);
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  }
  return attrs;
}

/** Publication metadata only: never substitute retrieval timestamps or dateModified. */
export function publicationDate(html: string): { day: string; field: string } | null {
  // Ignore commented metadata, scripts masquerading as markup, and non-JSON-LD script text.
  const content = html.replace(/<!--[\s\S]*?-->/g, '');
  const markup = content.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const metas = [...markup.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]));
  for (const meta of metas) {
    const day = isoDay(meta.content?.trim());
    if (meta.property?.toLowerCase() === 'article:published_time' && day) {
      return { day, field: '$.html.meta[article:published_time]' };
    }
  }
  function fromJson(value: unknown): string | null {
    if (Array.isArray(value)) {
      for (const item of value) { const day = fromJson(item); if (day) return day; }
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const day = typeof object.datePublished === 'string' ? isoDay(object.datePublished.trim()) : null;
      if (day) return day;
      for (const item of Object.values(object)) { const nested = fromJson(item); if (nested) return nested; }
    }
    return null;
  }
  for (const script of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attributes(script[1]).type?.toLowerCase() !== 'application/ld+json') continue;
    try {
      const day = fromJson(JSON.parse(script[2]));
      if (day) return { day, field: '$.html.jsonld.datePublished' };
    } catch { /* Malformed structured data does not prevent other publication metadata from being read. */ }
  }
  for (const meta of metas) {
    const name = meta.name?.toLowerCase();
    const day = isoDay(meta.content?.trim());
    if (name && ['date', 'pubdate', 'publish-date'].includes(name) && day) {
      return { day, field: `$.html.meta[${name}]` };
    }
  }
  for (const time of markup.matchAll(/<time\b[^>]*>/gi)) {
    const day = isoDay(attributes(time[0]).datetime?.trim());
    if (day) return { day, field: '$.html.time.datetime' };
  }
  return null;
}

export const newsSearch: EndpointSpec<SearchInput, TriggerBatch> = {
  name: 'news_search', path: '/web/search/live', method: 'POST',
  build({ intent, events }) {
    const providers = [...new Set(events.map(event => JSON.stringify(event.provider.trim())))];
    const words = [...new Set(events.map(event => ({ acquired: 'acquired', shutdown: 'shut down', shut_down: 'shut down', repriced: 'price' })[event.kind]))];
    return {
      query: `(${providers.join(' OR ')}) (${words.join(' OR ')})`, sources: ['news'],
      start_date: Date.parse(shiftDays(intent.asOf, -NEWS_WINDOW_DAYS)) / 1000,
      end_date: Date.parse(intent.asOf) / 1000,
    };
  },
  parse(raw, _input, meta) {
    const batch = emptyBatch();
    const seen = new Set<string>();
    for (const row of validate(searchResponse, raw).results) {
      if (row.source !== 'news' || !row.title.trim() || !publicUrl(row.url) || seen.has(row.url)) continue;
      seen.add(row.url);
      batch.evidence.push(evidenceRow({ ...meta, endpoint: 'news_search' }, row.url, '$.results.title',
        `News result: “${row.title}”`, null, row.title, row.url));
    }
    return batch;
  },
  estimateCredits: () => 1, // One search page per call; date filters do not date the returned articles.
};

export const newsFetch: EndpointSpec<FetchInput, TriggerBatch> = {
  // Crustdata calls this Web Fetch, but its documented API route is /web/enrich/live.
  name: 'news_fetch', path: '/web/enrich/live', method: 'POST',
  build({ urls }) {
    return { urls: validate(z.array(z.string().url()).min(1).max(NEWS_FETCH_LIMIT),
      [...new Set(urls.flatMap(url => newsPublisherUrl(url) ?? []))].slice(0, NEWS_FETCH_LIMIT)) };
  },
  parse(raw, input, meta) {
    const batch = emptyBatch();
    const requested = new Set((newsFetch.build(input) as { urls: string[] }).urls);
    const events = activeNewsEvents(input.events ?? configuredEvents, input.intent, meta.mode);
    const seen = new Set<string>();
    let undated = 0;
    let failed = 0;
    for (const page of validate(fetchResponse, raw)) {
      if (page.success !== true || !page.url || page.content == null) { failed++; continue; }
      if (!requested.has(page.url) || seen.has(page.url)) continue;
      seen.add(page.url);
      const date = publicationDate(page.content);
      if (!date) { undated++; continue; }
      const title = decodeHtml(page.title?.trim() || page.content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || 'Untitled article');
      const host = new URL(page.url).hostname;
      const fact: Evidence = evidenceRow({ ...meta, endpoint: 'news_fetch' }, page.url, date.field,
        `“${title}” was published on ${date.day} (${host}).`, date.day, title, page.url);
      batch.evidence.push(fact);
      for (const event of events) {
        if (event.date === date.day && containsPhrase(title + ' ' + decodeHtml(page.content), event.provider)) {
          batch.mentions.push({ key: 'displacement:' + event.provider, name: event.provider, evidenceIds: [fact.id] });
        }
      }
    }
    batch.readSummary = `${batch.evidence.length} dated articles; ${undated} pages had no publication date; not used${failed ? `; ${failed} pages failed to fetch` : ''}`;
    return batch;
  },
  estimateCredits: (_raw, input) => (newsFetch.build(input) as { urls: string[] }).urls.length,
};

export type AcquihirePair = { loser: string; hirers: string[] };
type AcquihireSearchInput = { intent: Intent; pairs: AcquihirePair[] };
type AcquihireResolveInput = { intent: Intent; lead: AcquisitionLead };
type AcquihireFetchInput = { intent: Intent; leads: AcquisitionLead[] };
const ACQUIHIRE_WINDOW_DAYS = 180;
const acquisitionWords = /\b(?:acquir\w*|acquisit\w*|acqui[-\s]?hir\w*|buy|buys|bought|absorb\w*|licen[cs]\w*|hire[sd]?\s+\d+\s+staff|join(?:s|ing)?)\b/i;
const pairSchema = z.object({ loser: z.string().trim().min(1), hirers: z.array(z.string().trim().min(1)).min(1) });

function acquisitionHirers(title: string, pair: AcquihirePair): string[] {
  return containsPhrase(title, pair.loser) && acquisitionWords.test(title)
    ? [...new Set(pair.hirers)].filter(hirer => containsPhrase(title, hirer)) : [];
}

function acquisitionSearchBatch(raw: unknown, pair: AcquihirePair, source: 'news' | 'web',
  meta: Parameters<typeof newsSearch.parse>[2], endpoint: string): TriggerBatch {
  const batch = emptyBatch();
  batch.acquisitionLeads = [];
  const seen = new Set<string>();
  for (const row of validate(searchResponse, raw).results) {
    if (row.source !== source || !row.title.trim() || !publicUrl(row.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    const fact = evidenceRow({ ...meta, endpoint }, row.url, '$.results.title',
      `News result: “${row.title}”`, null, row.title, row.url);
    batch.evidence.push(fact);
    for (const hirer of acquisitionHirers(row.title, pair)) {
      batch.acquisitionLeads.push({ acquisitionLead: true, loser: pair.loser, hirer,
        title: row.title, url: row.url, evidenceIds: [fact.id] });
    }
  }
  return batch;
}

export const newsAcquihireSearch: EndpointSpec<AcquihireSearchInput, TriggerBatch> = {
  name: 'news_acquihire_search', path: '/web/search/live', method: 'POST',
  build({ intent, pairs }) {
    // One request per call. The orchestrator invokes this separately for at most three pairs.
    const pair = validate(pairSchema, pairs[0]);
    return {
      query: `${JSON.stringify(pair.loser)} (${[...new Set(pair.hirers)].map(hirer => JSON.stringify(hirer)).join(' OR ')}) (acquire OR acquires OR acquisition OR acqui-hire OR "to hire" OR license OR licensing)`,
      sources: ['news'], start_date: Date.parse(shiftDays(intent.asOf, -ACQUIHIRE_WINDOW_DAYS)) / 1000,
      end_date: Date.parse(intent.asOf) / 1000,
    };
  },
  parse(raw, { pairs }, meta) {
    const pair = validate(pairSchema, pairs[0]);
    const batch = acquisitionSearchBatch(raw, pair, 'news', meta, 'news_acquihire_search');
    batch.readSummary = `${batch.acquisitionLeads!.length} acquisition leads for ${pair.loser}; publication dates unverified`;
    return batch;
  },
  estimateCredits: () => 1,
};

/** Spend one extra search credit to replace a Google redirect with a publisher URL. */
export const newsAcquihireResolve: EndpointSpec<AcquihireResolveInput, TriggerBatch> = {
  name: 'news_acquihire_resolve', path: '/web/search/live', method: 'POST',
  build: ({ lead }) => ({ query: lead.title, sources: ['web'] }),
  parse(raw, { lead }, meta) {
    const batch = acquisitionSearchBatch(raw, { loser: lead.loser, hirers: [lead.hirer] }, 'web', meta, 'news_acquihire_resolve');
    batch.acquisitionLeads = batch.acquisitionLeads!.filter(item => newsPublisherUrl(item.url));
    batch.readSummary = batch.acquisitionLeads.length ? `Found a direct publisher URL for ${lead.loser}`
      : `No direct publisher URL for ${lead.loser}; can't verify date`;
    return batch;
  },
  estimateCredits: () => 1,
};

export const newsAcquihireFetch: EndpointSpec<AcquihireFetchInput, TriggerBatch> = {
  name: 'news_acquihire_fetch', path: '/web/enrich/live', method: 'POST',
  build: ({ intent, leads }) => newsFetch.build({ intent, urls: leads.map(lead => lead.url) }),
  parse(raw, input, meta) {
    const batch = emptyBatch();
    batch.acquisitions = [];
    const requested = new Set((newsAcquihireFetch.build(input) as { urls: string[] }).urls);
    const seen = new Set<string>();
    let unverified = 0;
    for (const page of validate(fetchResponse, raw)) {
      if (page.success !== true || !page.url || page.content == null || !requested.has(page.url) || seen.has(page.url)) continue;
      seen.add(page.url);
      const title = decodeHtml(page.title?.trim() || page.content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || 'Untitled article');
      const date = publicationDate(page.content);
      const leads = input.leads.filter(lead => lead.url === page.url);
      for (const lead of leads) {
        if (!date || !inWindow(date.day, shiftDays(input.intent.asOf, -ACQUIHIRE_WINDOW_DAYS), input.intent.asOf)
          || !acquisitionHirers(title, { loser: lead.loser, hirers: [lead.hirer] }).length) {
          unverified++;
          continue;
        }
        const fact = evidenceRow({ ...meta, endpoint: 'news_acquihire_fetch' },
          JSON.stringify([page.url, lead.loser, lead.hirer]), date.field,
          `“${title}” (${new URL(page.url).hostname}, ${date.day}) reports that ${lead.hirer} acquired, licensed or hired the team of ${lead.loser}.`,
          date.day, title, page.url);
        batch.evidence.push(fact);
        batch.acquisitions.push({ acquirer: lead.hirer, acquired: lead.loser, date: date.day,
          sourceUrl: page.url, fixtureOnly: meta.mode === 'fixture' });
      }
    }
    const missing = [...requested].filter(url => !seen.has(url)).length;
    batch.readSummary = `${batch.acquisitions.length} dated acquisition reports${unverified + missing
      ? `; ${unverified + missing} pages unverified; can't verify date or acquisition headline` : ''}`;
    return batch;
  },
  estimateCredits: (_raw, input) => (newsAcquihireFetch.build(input) as { urls: string[] }).urls.length,
};

export type AcquihireReader = <I>(spec: EndpointSpec<I, TriggerBatch>, input: I) => Promise<TriggerBatch>;
export type AcquihireResult = { evidence: Evidence[]; acquisitions: AcquisitionEvent[]; reason?: string };
export type AcquihireOptions = { publisherHints?: { title: string; url: string }[] };

/** Context-free orchestration: inject a live, fixture, or engine reader; never infer a date from search. */
export async function acquihireCheck(intent: Intent, pairs: AcquihirePair[], read: AcquihireReader,
  options: AcquihireOptions = {}): Promise<AcquihireResult> {
  const result: AcquihireResult = { evidence: [], acquisitions: [] };
  if (intent.runKind === 'replay') return { ...result, reason: 'Skipped acqui-hire news in replay: web search has no as-of-safe dating' };
  let unverified = 0;
  const collect = (batch: TriggerBatch) => {
    result.evidence.push(...batch.evidence);
    result.acquisitions.push(...(batch.acquisitions ?? []));
  };
  for (const pair of pairs.slice(0, 3)) {
    const search = await read(newsAcquihireSearch, { intent, pairs: [pair] });
    collect(search);
    const leads: AcquisitionLead[] = [];
    // Bound discovery/fetch spend per pair; configured search requests still read a single page.
    for (const lead of (search.acquisitionLeads ?? []).slice(0, 5)) {
      if (newsPublisherUrl(lead.url)) leads.push(lead);
      else {
        const resolved = await read(newsAcquihireResolve, { intent, lead });
        collect(resolved);
        // Explicit caller-supplied publisher links may disambiguate a headline when Search still returns redirects.
        // They supply a URL only: Fetch must independently verify the headline and publication metadata.
        const hint = options.publisherHints?.find(item => newsPublisherUrl(item.url)
          && containsPhrase(item.title, lead.title) && containsPhrase(lead.title, item.title));
        const direct = resolved.acquisitionLeads?.find(item => newsPublisherUrl(item.url));
        if (hint) leads.push({ ...lead, url: hint.url });
        else if (direct) leads.push(direct);
        else unverified++;
      }
    }
    if (leads.length) {
      const uniqueLeads = [...new Map(leads.map(lead => [JSON.stringify([lead.url, lead.loser, lead.hirer]), lead])).values()];
      const fetched = await read(newsAcquihireFetch, { intent, leads: uniqueLeads });
      collect(fetched);
      unverified += leads.filter(lead => !fetched.acquisitions?.some(event =>
        event.acquirer === lead.hirer && event.acquired === lead.loser && event.sourceUrl === lead.url)).length;
    }
  }
  result.evidence = [...new Map(result.evidence.map(row => [row.id, row])).values()];
  result.acquisitions = [...new Map(result.acquisitions.map(event => [JSON.stringify(event), event])).values()];
  if (unverified) result.reason = `${unverified} acquisition leads: can't verify date or acquisition headline`;
  return result;
}
