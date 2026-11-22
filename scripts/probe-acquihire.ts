import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquihireCheck } from '../server/crustdata/news.ts';
import type { AcquihirePair, AcquihireReader, AcquihireResult } from '../server/crustdata/news.ts';
import { parseIntentRules } from '../server/domain/intent.ts';

export function acquihireProbeTable(result: AcquihireResult, pairs: AcquihirePair[]): string {
  const rows = pairs.flatMap(pair => {
    const reports = result.acquisitions.filter(event => event.acquired === pair.loser);
    return (reports.length ? reports : [undefined]).map(report => {
      const fact = report && result.evidence.find(row => row.source.endpoint === 'news_acquihire_fetch' && row.source.url === report.sourceUrl);
      return { loser: pair.loser, hirer: report?.acquirer ?? pair.hirers.join(', '),
        title: String(fact?.value ?? 'No dated acquisition report'), host: report?.sourceUrl ? new URL(report.sourceUrl).hostname : '—',
        date: report?.date ?? '—' };
    });
  });
  const key = process.env.CRUSTDATA_API_KEY;
  const cell = (value: unknown) => {
    const text = String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
    return key ? text.replaceAll(key, '[redacted]') : text;
  };
  return ['| Loser | Hirer | Title | Host | Published |', '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${Object.values(row).map(cell).join(' | ')} |`)].join('\n');
}

// Usage: bun --env-file=/Users/garudev/dev/domino/.env scripts/probe-acquihire.ts
// The same context-free helper accepts a fixture reader or the engine's readSource/publishSource adapter.
async function main() {
  const key = process.env.CRUSTDATA_API_KEY;
  if (!key?.trim()) throw new Error('CRUSTDATA_API_KEY is missing; run Bun with --env-file.');
  const redact = (value: string) => value.replaceAll(key, '[redacted]');
  const directory = fileURLToPath(new URL('../data/news-live/acquihire/', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const intent = { ...parseIntentRules('We sell recruiting for inference engineers.', '2026-11-22'), runKind: 'live' as const };
  const pairs: AcquihirePair[] = [
    { loser: 'Poolside', hirers: ['NVIDIA'] },
    { loser: 'Abacus.AI', hirers: ['Arcfront', 'Bravebird', 'Patronus AI'] },
  ];
  let lastCall = 0;
  let calls = 0;
  let credits = 0;
  const read: AcquihireReader = async (spec, input) => {
    const request = spec.build(input);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (calls >= 29) throw new Error('Live call limit reached.');
      await sleep(Math.max(0, lastCall + 3000 - Date.now()));
      lastCall = Date.now();
      calls++;
      const response = await fetch(new URL(spec.path, 'https://api.crustdata.com'), {
        method: spec.method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-api-version': '2025-11-01' },
        body: JSON.stringify(request),
      });
      const retrievedAt = new Date().toISOString();
      const text = redact(await response.text());
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { raw = { body: text }; }
      const envelope = { label: 'live-cached', retrievedAt, endpoint: spec.name, path: spec.path,
        status: response.status, request, response: raw };
      await writeFile(`${directory}${retrievedAt.replace(/[:.]/g, '-')}-${String(calls).padStart(2, '0')}-${spec.name}.json`,
        redact(JSON.stringify(envelope, null, 2)) + '\n', { mode: 0o600 });
      const charged = response.headers.get('X-Credits-Used');
      credits += charged?.trim() && Number.isFinite(Number(charged)) ? Number(charged)
        : response.ok ? spec.estimateCredits(raw, input) : 0;
      console.log(`${spec.name}: HTTP ${response.status}`);
      if (response.status === 429 && attempt < 3) {
        const retry = response.headers.get('Retry-After');
        const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
        await sleep(Math.max(20_000, Number.isFinite(delay) ? delay : 0));
        continue;
      }
      if (!response.ok) throw new Error(`${spec.name}: HTTP ${response.status}; raw response saved.`);
      return spec.parse(raw, input, { mode: 'live', endpoint: spec.name, retrievedAt,
        asOf: intent.asOf, windowDays: intent.windowDays });
    }
    throw new Error('Retry limit reached.');
  };

  // The caller supplied this publisher URL in the brief. It is never guessed from a redirect.
  const publisherHints = [{ title: 'Nvidia pays Poolside $6bn to license its model factory and hire 109 staff',
    url: 'https://thenextweb.com/news/nvidia-poolside-6bn-model-factory-licence' }];
  const result = await acquihireCheck(intent, pairs, read, { publisherHints });
  const table = acquihireProbeTable(result, pairs);
  console.log(table);
  console.log(`${calls} live calls; ${credits} credits; ${result.acquisitions.length} verified reports.${result.reason ? ` ${result.reason}` : ''}`);
  await writeFile(`${directory}summary.md`, table + '\n', { mode: 0o600 });
  await writeFile(`${directory}summary.json`, redact(JSON.stringify({ label: 'live-cached', retrievedAt: new Date().toISOString(),
    asOf: intent.asOf, calls, credits, pairs, publisherHints, ...result }, null, 2)) + '\n', { mode: 0o600 });
}

if (import.meta.main) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'Acqui-hire probe failed';
    const key = process.env.CRUSTDATA_API_KEY;
    console.error(key ? message.replaceAll(key, '[redacted]') : message);
    process.exitCode = 1;
  });
}
