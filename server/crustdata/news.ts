import { z } from 'zod';
import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { DataMode, Evidence, Intent } from '../../shared/types.ts';
import { containsPhrase, inWindow, isoDay, shiftDays } from '../domain/facts.ts';
import type { SellerProfile, TriggerBatch } from '../domain/types.ts';
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
