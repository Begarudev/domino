import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Company, Evidence, Intent } from '../shared/types.ts';
import { companyEnrich, companySearchGrowth } from '../server/crustdata/company.ts';
import { sameCompany } from '../server/crustdata/common.ts';
import { jobSearch } from '../server/crustdata/job-search.ts';
import { outcomeCheck } from '../server/crustdata/outcome-check.ts';
import { personSearchDeciders, personSearchRecentMoves } from '../server/crustdata/person-search.ts';
import type { EndpointSpec } from '../server/crustdata/spec.ts';
import { shiftDays } from '../server/domain/facts.ts';
import type { CompanyMention, OutcomeFact, TriggerBatch } from '../server/domain/types.ts';

export const liveIntent: Intent = {
  offering: 'managed GPU inference', buyerProfile: 'AI companies', geography: null,
  windowDays: 30, asOf: '2026-11-22', runKind: 'live', horizonEnd: null, parsedBy: 'rules',
  signalKeywords: ['inference', 'ML platform', 'ML infrastructure', 'GPU', 'LLM serving', 'model serving', 'MLOps'],
  deciderTitles: ['CTO', 'VP Engineering', 'Head of ML/AI', 'Head of Infrastructure', 'Head of ML Platform', 'Co-founder'],
  maxTargets: 5, assumptions: [],
};
export const replayIntent: Intent = { ...liveIntent, runKind: 'replay', asOf: '2026-09-01', horizonEnd: liveIntent.asOf };

const searchRows: Partial<Record<string, string>> = {
  '/job/search': 'job_listings', '/person/search': 'profiles', '/company/search': 'companies',
};
type Parsed = Partial<TriggerBatch> & { outcomes?: OutcomeFact[] };
type Call = {
  intent: Intent['runKind']; asOf: string; endpoint: string; path: string; leg?: 'jobs' | 'hires';
  status: number | null; latencyMs: number | null; creditsHeader: number | null; credits: number;
  totalCount: number | null; returned: number | null;
  parsed: Record<'mentions' | 'people' | 'triggers' | 'evidence' | 'outcomes', number> | null;
  examples: Pick<Evidence, 'claim' | 'observedAt'>[];
  error?: string;
};
type Options = { searchLimit: number; maxCredits: number; cacheDir?: string; onCall?: (row: Call) => void };
class BudgetExceeded extends Error {}

function get(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// Match the core snapshot importer's object key ordering and preserve array order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(get(value, key))]));
  }
  return value;
}

function redact(value: string): string {
  const key = process.env.CRUSTDATA_API_KEY;
  return key ? value.replaceAll(key, '[redacted]') : value;
}

function safeResponse(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(safeResponse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/email|phone|mobile.?number|contact.?number/i.test(key))
      .map(([key, child]) => [redact(key), safeResponse(child)]));
  }
  return value;
}

function errorMessage(raw: unknown): string {
  const error = get(raw, 'error');
  const message = [get(error, 'message'), get(raw, 'message'), get(raw, 'detail'), error, raw]
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return message?.trim() ?? 'No error message in response body';
}

async function writeSnapshot(dir: string, row: Call, requestJson: string, raw: unknown, fetchedAt: string) {
  const key = createHash('sha256').update(row.path + requestJson).digest('hex');
  const file = join(dir, `${row.endpoint}__${key.slice(0, 16)}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  const snapshot = {
    key, provider: 'crustdata', endpoint: row.path, request_json: requestJson,
    response_json: JSON.stringify(raw), fetched_at: fetchedAt,
  };
  try {
    await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export class LiveProbe {
  readonly calls: Call[] = [];
  creditsUsed = 0;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  async call<I, O extends Parsed>(spec: EndpointSpec<I, O>, input: I | null, intent: Intent, leg?: Call['leg']): Promise<O | null> {
    const row: Call = {
      intent: intent.runKind, asOf: intent.asOf, endpoint: spec.name, path: spec.path, leg,
      status: null, latencyMs: null, creditsHeader: null, credits: 0, totalCount: null, returned: null,
      parsed: null, examples: [],
    };
    this.calls.push(row);

    try {
      if (!input) {
        row.error = 'Skipped because discovery returned no companies';
        return null;
      }

      const built = spec.build(input);
      const responseKey = searchRows[spec.path];
      const limit = this.options.searchLimit;
      const body = typeof built === 'object' && built && 'limit' in built ? { ...built, limit } : built;
      const requestJson = JSON.stringify(canonical(body));
      const estimatedPage = responseKey ? { [responseKey]: Array.from({ length: limit }) } : null;
      const reservedCredits = spec.estimateCredits(estimatedPage, input);
      if (this.creditsUsed + reservedCredits > this.options.maxCredits + 1e-9) {
        throw new BudgetExceeded(`Credit cap ${this.options.maxCredits} would be exceeded (${this.creditsUsed.toFixed(2)} used, ${reservedCredits} needed)`);
      }

      const url = new URL(spec.path, process.env.CRUSTDATA_BASE_URL || 'https://api.crustdata.com');
      const start = performance.now();
      row.credits = reservedCredits;
      let raw: unknown;
      let response: Response;
      try {
        response = await fetch(url, {
          method: spec.method, body: requestJson, signal: AbortSignal.timeout(15_000), redirect: 'error',
          headers: {
            Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`,
            'x-api-version': '2025-11-01', 'Content-Type': 'application/json',
          },
        });
        row.status = response.status;
        const header = response.headers.get('X-Credits-Used');
        if (header?.trim() && Number.isFinite(Number(header)) && Number(header) >= 0) {
          row.creditsHeader = row.credits = Number(header);
        }
        const text = await response.text();
        try { raw = safeResponse(JSON.parse(text)); } catch { raw = redact(text); }
      } finally {
        row.latencyMs = Math.round(performance.now() - start);
      }

      const total = get(raw, 'total_count');
      row.totalCount = typeof total === 'number' ? total : null;
      const returned = responseKey ? get(raw, responseKey) : raw;
      row.returned = Array.isArray(returned) ? returned.length : null;
      if (!response.ok) {
        row.error = response.status === 400 ? `HTTP 400 ${errorMessage(raw)}` : `HTTP ${response.status}`;
        return null;
      }

      row.credits = row.creditsHeader ?? (row.returned === null ? reservedCredits : spec.estimateCredits(raw, input));
      const fetchedAt = new Date().toISOString();
      const parsed = spec.parse(raw, input, {
        mode: 'live', retrievedAt: fetchedAt, endpoint: spec.path, asOf: intent.asOf, windowDays: intent.windowDays,
      });
      row.parsed = {
        mentions: parsed.mentions?.length ?? 0, people: parsed.people?.length ?? 0,
        triggers: parsed.triggers?.length ?? 0, evidence: parsed.evidence?.length ?? 0, outcomes: parsed.outcomes?.length ?? 0,
      };
      row.examples = (parsed.evidence ?? []).slice(0, 2).map(({ claim, observedAt }) => ({ claim: redact(claim), observedAt }));
      if (this.options.cacheDir) await writeSnapshot(this.options.cacheDir, row, requestJson, raw, fetchedAt);
      return parsed;
    } catch (error) {
      row.error = redact(error instanceof Error ? error.message : 'Probe call failed');
      if (error instanceof BudgetExceeded) throw error;
      return null;
    } finally {
      this.creditsUsed += row.credits;
      this.options.onCall?.(row);
    }
  }
}

export async function probeIntent(probe: LiveProbe, intent: Intent, enrichCount: number, outcomeIntent: Intent) {
  const jobs = await probe.call(jobSearch, { intent }, intent);
  const moves = await probe.call(personSearchRecentMoves, { intent }, intent);
  const growth = await probe.call(companySearchGrowth, { intent }, intent);
  const companies: CompanyMention[] = [];
  for (const batch of [jobs, moves, growth]) {
    for (const mention of batch?.mentions ?? []) {
      if (companies.length === enrichCount) break;
      if (mention.key.startsWith('displacement:') || companies.some(company => sameCompany(company, mention))) continue;
      companies.push(mention);
    }
  }

  await probe.call(companyEnrich, companies.length ? { companies } : null, intent);
  const target = companies[0];
  const company: Company | null = target ? { ...target, id: target.key, aliases: [] } : null;
  await probe.call(personSearchDeciders, company ? { intent, company } : null, intent);
  const outcome = target ? { intent: outcomeIntent, companies: [target] } : null;
  await probe.call(outcomeCheck, outcome, outcomeIntent, 'jobs');
  await probe.call(outcomeCheck.hires, outcome, outcomeIntent, 'hires');
}

function loadEnv() {
  for (const file of new Set([resolve('.env'), '/Users/garudev/dev/domino/.env'])) {
    try { process.loadEnvFile(file); } catch (error) {
      if (get(error, 'code') !== 'ENOENT') throw error;
    }
  }
}

async function main() {
  loadEnv();
  if (!process.env.CRUSTDATA_API_KEY?.trim()) {
    console.error('CRUSTDATA_API_KEY is missing. Set it in the environment or in .env (current directory or /Users/garudev/dev/domino).');
    return 2;
  }

  let cacheDir: string | undefined;
  let maxCredits = 60;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--write-cache' && value && !value.startsWith('--')) cacheDir = value;
    else if (flag === '--max-credits' && value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) maxCredits = Number(value);
    else throw new Error('Usage: node scripts/probe-live.ts [--write-cache DIR] [--max-credits N]');
  }
  if (cacheDir) await mkdir(cacheDir, { recursive: true, mode: 0o700 });

  const probe = new LiveProbe({ searchLimit: 5, maxCredits, cacheDir, onCall(row) {
    const name = [row.intent, row.endpoint, row.leg].filter(Boolean).join(' ');
    const status = row.error ?? `${row.status} in ${row.latencyMs} ms`;
    console.log(redact(`${name} (${row.asOf}) ${status}`));
    for (const example of row.examples) console.log(`  ${example.observedAt ?? 'undated'} ${example.claim}`);
  } });
  let budgetBlocked = false;
  try {
    // The live probe also exercises the outcome request shapes with a forward window.
    await probeIntent(probe, liveIntent, 2, { ...liveIntent, horizonEnd: shiftDays(liveIntent.asOf, liveIntent.windowDays) });
    await probeIntent(probe, replayIntent, 2, replayIntent);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    budgetBlocked = true;
  }
  console.table(probe.calls.map(({ intent, asOf, endpoint, leg, status, latencyMs, creditsHeader, credits, totalCount, returned, parsed }) => ({
    intent, asOf, endpoint: leg ? `${endpoint} ${leg}` : endpoint, status, latencyMs, creditsHeader, credits, totalCount, returned, ...parsed,
  })));
  console.log(JSON.stringify({ maxCredits, creditsUsed: Number(probe.creditsUsed.toFixed(6)), budgetBlocked, calls: probe.calls }, null, 2));
  return probe.calls.some(row => row.error) ? 1 : 0;
}

if (import.meta.main) {
  try { process.exitCode = await main(); } catch (error) {
    console.error(redact(error instanceof Error ? error.message : 'Probe failed'));
    process.exitCode = 1;
  }
}
