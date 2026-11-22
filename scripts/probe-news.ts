import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import seller from '../config/seller.json' with { type: 'json' };
import { activeNewsEvents, newsFetch, newsFetchUrls, newsSearch, publicationDate } from '../server/crustdata/news.ts';
import type { EndpointSpec } from '../server/crustdata/spec.ts';
import { parseIntentRules } from '../server/domain/intent.ts';
import type { SellerProfile, TriggerBatch } from '../server/domain/types.ts';

// Usage: bun --env-file=/Users/garudev/dev/domino/.env scripts/probe-news.ts
async function main() {
  const key = process.env.CRUSTDATA_API_KEY;
  if (!key?.trim()) throw new Error('CRUSTDATA_API_KEY is missing; run Bun with --env-file.');
  const redact = (value: string) => value.replaceAll(key, '[redacted]');
  const directory = fileURLToPath(new URL('../data/news-live/', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const intent = parseIntentRules('We sell managed GPU inference.', new Date().toISOString().slice(0, 10));
  const events = activeNewsEvents((seller as SellerProfile).displacementEvents, intent, 'live');
  if (!events.length) throw new Error('No active non-fixture displacement events configured.');
  let lastCall = 0;
  let calls = 0;
  let credits = 0;

  async function call<I>(spec: EndpointSpec<I, TriggerBatch>, input: I) {
    const body = spec.build(input);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await sleep(Math.max(0, lastCall + 3000 - Date.now()));
      lastCall = Date.now();
      calls++;
      const response = await fetch(new URL(spec.path, 'https://api.crustdata.com'), {
        method: spec.method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-api-version': '2025-11-01' },
        body: JSON.stringify(body),
      });
      const text = redact(await response.text());
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { raw = { body: text }; }
      const file = `${directory}${spec.name}${attempt > 1 ? `-attempt-${attempt}` : ''}.json`;
      await writeFile(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
      const charged = response.headers.get('X-Credits-Used');
      credits += charged !== null && Number.isFinite(Number(charged)) ? Number(charged)
        : response.ok ? spec.estimateCredits(raw, input) : 0;
      console.log(`${spec.name}: HTTP ${response.status} (${spec.path})`);
      if (response.status === 429 && attempt < 4) {
        const retry = Number(response.headers.get('Retry-After'));
        await sleep(Math.max(20_000, Number.isFinite(retry) ? retry * 1000 : 0));
        continue;
      }
      if (!response.ok) throw new Error(`${spec.name} failed: HTTP ${response.status}; raw response saved.`);
      const batch = spec.parse(raw, input, { mode: 'live', endpoint: spec.name,
        retrievedAt: new Date().toISOString(), asOf: intent.asOf, windowDays: intent.windowDays });
      return { batch, raw };
    }
    throw new Error('Retry limit reached.');
  }

  const search = await call(newsSearch, { intent, events });
  const urls = newsFetchUrls(events, search.batch);
  const fetched = await call(newsFetch, { intent, urls, events });
  const pages = fetched.raw as { success?: boolean; title?: string; url?: string; content?: string }[];
  const rows = urls.map(url => {
    const page = pages.find(page => page.url === url);
    return { title: page?.title || (page?.success ? 'Untitled article' : '(fetch failed)'),
      host: new URL(url).hostname, published: page?.success ? publicationDate(page.content ?? '')?.day ?? 'undated — not used' : 'unavailable' };
  });
  const cell = (value: string) => redact(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const table = ['| Title | Host | Published date |', '| --- | --- | --- |',
    ...rows.map(row => `| ${cell(row.title)} | ${cell(row.host)} | ${cell(row.published)} |`)].join('\n');
  console.log(table);
  console.log(`${calls} live calls; ${credits} credits; ${search.batch.evidence.length} undated search leads; ${fetched.batch.readSummary}`);
  await writeFile(`${directory}summary.md`, table + '\n', { mode: 0o600 });
}

if (import.meta.main) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'News probe failed';
    const key = process.env.CRUSTDATA_API_KEY;
    console.error(key ? message.replaceAll(key, '[redacted]') : message);
    process.exitCode = 1;
  });
}
