import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BudgetState, ChaosConfig, DataMode, LedgerEntry, RunEvent } from '../../shared/types.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import { NonsenseError } from '../domain/types.ts';
import type { ParseMeta } from '../domain/types.ts';
import { decode, now, Store } from '../db.ts';
import { redactSecrets } from '../env.ts';

type RetryReason = Extract<RunEvent, { type: 'tool.retry' }>['reason'];
type Exhausted = NonNullable<BudgetState['exhausted']>;
type Cost = Pick<LedgerEntry, 'credits' | 'usd' | 'inputTokens' | 'outputTokens'>;
type AttemptCost = Partial<Cost>;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}

export function sanitize(value: unknown, stripContactFields = false): unknown {
  if (typeof value === 'string') {
    const clean = redactSecrets(value);
    return stripContactFields ? clean.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[contact redacted]')
      .replace(/\+(?:\d[ .()-]?){8,14}\d\b/g, '[contact redacted]') : clean;
  }
  if (Array.isArray(value)) return value.map(child => sanitize(child, stripContactFields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !stripContactFields || !/email|phone|mobile.?number|contact.?number/i.test(key))
      .map(([key, child]) => [redactSecrets(key), sanitize(child, stripContactFields)]));
  }
  return value;
}

export class BudgetError extends Error {
  readonly reason: Exhausted;

  constructor(reason: Exhausted) {
    super(`Run reached its ${reason} ceiling`);
    this.reason = reason;
  }
}

interface FailureDetails {
  status?: number;
  retryAfterMs?: number;
}

export class ToolError extends Error {
  readonly retry?: RetryReason;
  readonly ledgerStatus: LedgerEntry['status'];
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, retry?: RetryReason, ledgerStatus: LedgerEntry['status'] = 'error', details: FailureDetails = {}) {
    super(safeError(message));
    this.retry = retry;
    this.ledgerStatus = ledgerStatus;
    this.httpStatus = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

function safeError(value: string): string {
  return redactSecrets(value).replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[credential redacted]')
    .replace(/\b(?:sk|rk)-(?:ant-|proj-)?[a-z0-9_-]{8,}/gi, '[credential redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 480);
}

function providerMessage(body: unknown): string {
  if (typeof body === 'string') return body.trim().startsWith('<') ? '' : body;
  if (!body || typeof body !== 'object') return '';
  const fields = body as Record<string, unknown>;
  for (const value of [fields.error, fields.message, fields.detail, fields.errors]) {
    if (Array.isArray(value)) {
      const messages = value.slice(0, 3).map(providerMessage).filter(Boolean);
      if (messages.length) return messages.join('. ');
      continue;
    }
    const message = providerMessage(value);
    if (message) return message;
  }
  return typeof fields.msg === 'string' ? fields.msg : typeof fields.code === 'string' ? fields.code : '';
}

function retryDelay(header: string | null | undefined): number | undefined {
  if (!header?.trim()) return;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : undefined;
}

export function httpError(status: number, body?: unknown, retryAfter?: string | null): ToolError {
  const retry = status === 429 ? 'rate_limit' : status >= 500 ? 'http_5xx' : undefined;
  const message = safeError(providerMessage(body));
  return new ToolError(`HTTP ${status}${message ? ` ${message}` : ''}`, retry, 'error', {
    status, retryAfterMs: retry === 'rate_limit' ? retryDelay(retryAfter) : undefined,
  });
}

export async function responseError(response: Response): Promise<ToolError> {
  const text = await response.text().catch(() => '');
  let body: unknown = text;
  if (text) {
    try { body = JSON.parse(text); } catch { /* The provider may return a plain-text error. */ }
  }
  return httpError(response.status, body, response.headers.get('Retry-After'));
}

export function networkError(error: unknown): ToolError {
  if (!(error instanceof Error)) return new ToolError('Provider network failure', 'network');
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return new ToolError(`Provider network failure: ${error.message}${cause}`, 'network');
}

function classify(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof NonsenseError) return new ToolError(error.message, 'nonsense', 'nonsense');
  return new ToolError(error instanceof Error ? error.message : 'Tool call failed');
}

function spacingFor(path: string) {
  const value = path === '/person/search' ? process.env.DOMINO_CRUST_PERSON_SPACING_MS : undefined;
  const ms = Number(value ?? process.env.DOMINO_CRUST_SPACING_MS ?? 4500);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : 4500;
}

const zeroCost: Cost = { credits: 0, usd: 0, inputTokens: 0, outputTokens: 0 };
const timeoutError = new ToolError('Tool call timed out', 'timeout', 'timeout');
const garbage = { rows: '<<garbage>>' };

export function exhaust(store: Store, runId: string, reason: Exhausted) {
  const budget = { ...store.budget(runId), exhausted: reason };
  if (store.requireRun(runId).status !== 'budget_exhausted') {
    store.recordEvent(runId, { type: 'run.status', status: 'budget_exhausted', note: new BudgetError(reason).message });
  }
  store.recordEvent(runId, { type: 'budget.update', budget });
}

export interface CrustReadMeta {
  callId: string;
  mode: DataMode;
  request: unknown;
  totalAvailable: number | null;
}

function totalAvailable(raw: unknown) {
  if (!raw || typeof raw !== 'object' || !('total_count' in raw)) return null;
  const count = typeof raw.total_count === 'string' && /^\d+$/.test(raw.total_count) ? Number(raw.total_count) : raw.total_count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

interface Attempt<T> {
  mode: LedgerEntry['mode'];
  estimate?: AttemptCost;
  timeoutMs?: number;
  maxAttempts?: number;
  run: (signal: AbortSignal, report: (cost: AttemptCost) => void) => Promise<T>;
  inject: (raw: unknown) => T;
}

interface Call<T> {
  provider: LedgerEntry['provider'];
  endpoint: string;
  path?: string;
  body: unknown;
  attempt: Attempt<T>;
}

export class ToolContext {
  readonly store: Store;
  readonly runId: string;
  readonly mode: DataMode;
  readonly step: string;
  readonly signal?: AbortSignal;
  readonly recheck: boolean;

  constructor(store: Store, runId: string, step: string, options: { signal?: AbortSignal; recheck?: boolean } = {}) {
    this.store = store;
    this.runId = runId;
    this.mode = store.requireRun(runId).data_mode;
    this.step = step;
    this.signal = options.signal;
    this.recheck = options.recheck ?? false;
  }

  async wait(ms: number) {
    const finish = Date.now() + ms;
    do {
      const remaining = this.remainingSeconds() * 1000;
      const delay = Math.max(0, Math.min(finish - Date.now(), Math.ceil(remaining), 2_147_483_647));
      try {
        await sleep(delay, undefined, { signal: this.signal });
      } catch (error) {
        this.signal?.throwIfAborted();
        throw error;
      }
      this.assertTime();
    } while (Date.now() < finish);
  }

  private remainingSeconds() {
    this.signal?.throwIfAborted();
    if (this.recheck) return Infinity;
    const budget = this.store.budget(this.runId);
    if (budget.exhausted) throw new BudgetError(budget.exhausted);
    return budget.limits.maxSeconds - budget.used.seconds;
  }

  assertTime() {
    if (this.remainingSeconds() <= 0) throw new BudgetError('seconds');
  }

  async tool<T>(call: Call<T>): Promise<T> {
    return this.attempts(call, randomUUID());
  }

  async crust<I, O>(
    spec: EndpointSpec<I, O>, input: I, time: Pick<ParseMeta, 'asOf' | 'windowDays'>,
    fixture: (path: string, body: unknown) => unknown, unavailable: () => O,
    onRead?: (read: CrustReadMeta) => void,
  ): Promise<O> {
    const body = sanitize(spec.build(input));
    const request = canonicalJson(body);
    const key = hash(spec.path + request);
    const callId = randomUUID();
    const parse = (raw: unknown, mode: DataMode, injected = false) => {
      const result = spec.parse(raw, input, { ...time, mode, endpoint: spec.path, retrievedAt: now() });
      if (!injected) onRead?.({ callId, mode, request: body, totalAvailable: totalAvailable(raw) });
      return result;
    };

    const run = (mode: DataMode, attempt: Attempt<O>['run'], estimate?: AttemptCost) => this.attempts({
      provider: 'crustdata', endpoint: spec.name, path: spec.path, body,
      attempt: { mode, run: attempt, inject: raw => parse(raw, mode, true), estimate, timeoutMs: 15_000 },
    }, callId);

    if (this.mode === 'fixture') {
      return run('fixture', async () => {
        await this.wait(150 + Math.floor(Math.random() * 301));
        return parse(fixture(spec.path, body), 'fixture');
      });
    }

    const fromCache = () => run('cache', async () => {
      const raw = this.store.readCache(key);
      if (raw === undefined) throw new ToolError('Cache miss');
      return parse(raw, 'cache');
    });
    if (this.mode === 'live' && !this.recheck && this.store.readCache(key) !== undefined) {
      try {
        return await fromCache();
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
      }
    }
    if (this.mode === 'live' && !process.env.CRUSTDATA_API_KEY) {
      this.fallback(callId, spec.name, 'live', 'cache', 'Crustdata key unavailable');
    } else if (this.mode === 'live') {
      try {
        return await run('live', async (signal, report) => {
          const url = new URL(spec.path, 'https://api.crustdata.com');
          if (url.origin !== 'https://api.crustdata.com') throw new ToolError('Invalid Crustdata endpoint');
          if (spec.method === 'GET' && body && typeof body === 'object') {
            for (const [name, value] of Object.entries(body)) {
              if (value !== undefined && value !== null) {
                if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, String(item));
                else url.searchParams.set(name, typeof value === 'object' ? canonicalJson(value) : String(value));
              }
            }
          }
          const response = await providerFetch(url, {
            method: spec.method, signal, redirect: 'error',
            headers: {
              'Content-Type': 'application/json', 'x-api-version': '2025-11-01',
              Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`,
            },
            body: spec.method === 'POST' ? request : undefined,
          });
          const header = response.headers.get('X-Credits-Used');
          const credits = header !== null && header.trim() && Number.isFinite(Number(header)) && Number(header) >= 0
            ? Number(header) : undefined;
          if (credits !== undefined) report({ credits });
          if (!response.ok) throw await responseError(response);
          report({ credits: credits ?? spec.estimateCredits(null, input) });
          const raw = sanitize(await responseJson(response), true);
          report({ credits: credits ?? spec.estimateCredits(raw, input) });
          signal.throwIfAborted();
          const output = parse(raw, 'live');
          this.store.writeCache(key, 'crustdata', spec.path, request, raw);
          return output;
        }, { credits: spec.estimateCredits(null, input) });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        this.fallback(callId, spec.name, 'live', 'cache', error.message);
      }
    }
    try {
      return await fromCache();
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      this.store.appendEvent(this.runId, { type: 'log', level: 'warn', message: 'source unavailable, continuing without it' });
      return unavailable();
    }
  }

  private fallback(callId: string, endpoint: string, from: DataMode, to: DataMode, reason: string) {
    this.store.appendEvent(this.runId, { type: 'tool.fallback', callId, endpoint, from, to, reason, error: reason });
  }

  private budgetBlock(mode: LedgerEntry['mode'], estimate: AttemptCost | undefined): Exhausted | undefined {
    const budget = this.store.budget(this.runId);
    if (!this.recheck) {
      if (budget.exhausted) return budget.exhausted;
      if (this.signal?.aborted || budget.used.seconds >= budget.limits.maxSeconds) return 'seconds';
    }
    if (mode === 'live' && (budget.used.credits >= budget.limits.maxCredits ||
      budget.used.credits + (estimate?.credits ?? 0) > budget.limits.maxCredits + 1e-9)) return 'credits';
    if (mode === 'model' && (budget.used.modelUsd >= budget.limits.maxModelUsd ||
      budget.used.modelUsd + (estimate?.usd ?? 0) > budget.limits.maxModelUsd + 1e-12)) return 'model_usd';
  }

  private async leaseEndpoint(path: string, timeoutMs: number) {
    const lease = randomUUID();
    const spacing = spacingFor(path);
    for (;;) {
      this.assertTime();
      const next = this.store.transaction(() => {
        const record = this.store.sql.prepare('SELECT next_at, lease_until FROM tool_slots WHERE endpoint = ?').get(path);
        const now = Date.now();
        const availableAt = Math.max(Number(record?.next_at ?? 0), Number(record?.lease_until ?? 0));
        if (availableAt > now) return availableAt;
        this.store.sql.prepare(`INSERT INTO tool_slots (endpoint, next_at, lease_id, lease_until) VALUES (?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET next_at = excluded.next_at, lease_id = excluded.lease_id, lease_until = excluded.lease_until`)
          .run(path, now + spacing, lease, now + timeoutMs + 2000);
        return 0;
      });
      if (next === 0) break;
      await this.wait(Math.max(1, Math.min(next - Date.now(), 200)));
    }
    return (retryAfterMs?: number) => {
      const retryAt = retryAfterMs ? Math.min(Number.MAX_SAFE_INTEGER, Date.now() + retryAfterMs) : 0;
      this.store.sql.prepare(`UPDATE tool_slots SET lease_id = NULL, lease_until = 0, next_at = max(next_at, ?)
        WHERE endpoint = ? AND lease_id = ?`).run(retryAt, path, lease);
    };
  }

  private async attempts<T>(call: Call<T>, callId: string): Promise<T> {
    const { mode, estimate, timeoutMs = 12_000 } = call.attempt;
    const paid = mode === 'live' || mode === 'model';
    const requestHash = hash((call.path ?? call.endpoint) + canonicalJson(call.body));
    const chaos = this.recheck ? {} : decode<ChaosConfig>(this.store.requireRun(this.runId).chaos_json);
    let maxAttempts = call.attempt.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const matches = (names?: string[]) => names?.some(name => name === call.endpoint || name === call.path);
      const injectTimeout = attempt === 1 && Boolean(matches(chaos.timeoutOnce));
      const injectNonsense = attempt === 1 && !injectTimeout && Boolean(matches(chaos.nonsenseOnce));
      const injected = (mode === this.mode || mode === 'model') && (injectTimeout || injectNonsense);
      const alreadyBlocked = this.budgetBlock(mode, estimate);
      const release = mode === 'live' && !injected && !alreadyBlocked
        ? await this.leaseEndpoint(call.path ?? call.endpoint, timeoutMs) : undefined;
      let failure: ToolError | undefined;
      try {
        const entry = this.store.transaction(() => {
          // Re-read the limits under the write lock before reserving any spend.
          const reason = alreadyBlocked ?? this.budgetBlock(mode, estimate);
          const row = this.store.beginLedger({
            ...zeroCost, ...(!reason && paid && !injected ? estimate : {}),
            runId: this.runId, step: this.step, provider: call.provider, endpoint: call.endpoint,
            mode, status: reason ? 'budget_blocked' : 'error', attempt, latencyMs: 0, injected: injected && !reason,
          }, requestHash);
          if (reason) {
            this.store.finishLedger({ ...row, error: new BudgetError(reason).message });
            if (!this.recheck) exhaust(this.store, this.runId, reason);
            else this.store.recordEvent(this.runId, { type: 'budget.update', budget: this.store.budget(this.runId) });
          } else {
            this.store.recordEvent(this.runId, { type: 'tool.call', callId, provider: call.provider, endpoint: call.endpoint, mode, attempt });
          }
          return { row, reason };
        });
        if (entry.reason) throw new BudgetError(entry.reason);
        const result = await this.runAttempt(call, entry.row, callId, injected, injectTimeout, timeoutMs);
        failure = result.failure;
        if (!failure) return result.output as T;
      } finally {
        release?.(failure?.retryAfterMs);
      }

      if (mode === 'live' && !injected && failure.retry === 'nonsense') maxAttempts = Math.min(maxAttempts, attempt + 1);
      if (!failure.retry || attempt >= maxAttempts || (mode === 'cache' && !injected)) throw failure;
      const newsRateLimit = mode === 'live' && !injected && failure.retry === 'rate_limit' &&
        (call.endpoint === 'news_search' || call.endpoint === 'news_fetch');
      const backoffMs = Math.max(newsRateLimit ? 20_000 : 0, failure.retryAfterMs ?? 0,
        180 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
      this.store.appendEvent(this.runId, {
        type: 'tool.retry', callId, endpoint: call.endpoint, reason: failure.retry, attempt, backoffMs, injected, error: failure.message,
      });
      await this.wait(backoffMs);
    }
    throw new ToolError('Tool attempts exhausted');
  }

  private async runAttempt<T>(
    call: Call<T>, entry: LedgerEntry, callId: string, injected: boolean, injectTimeout: boolean, timeoutMs: number,
  ) {
    const mode = call.attempt.mode;
    const start = performance.now();
    const cost = { ...zeroCost };
    let output: T | undefined;
    let failure: ToolError | undefined;
    let budgetFailure: BudgetError | undefined;
    let startedRequest = false;
    try {
      if (injected && injectTimeout) {
        await this.wait(1200);
        throw timeoutError;
      }
      const wallMs = this.remainingSeconds() * 1000;
      output = injected ? call.attempt.inject(garbage) : await withTimeout(
        Math.max(1, Math.min(timeoutMs, Math.ceil(wallMs))), this.signal, signal => {
          startedRequest = true;
          return call.attempt.run(signal, reported => Object.assign(cost, reported));
        },
        wallMs <= timeoutMs ? new BudgetError('seconds') : timeoutError,
      );
    } catch (error) {
      budgetFailure = error instanceof BudgetError ? error : undefined;
      failure = budgetFailure ? new ToolError(budgetFailure.message, undefined, 'timeout') : classify(error);
    }
    // The provider can still bill a request after the client aborts without receiving usage.
    if (startedRequest && mode === 'model' && failure?.ledgerStatus === 'timeout' && !cost.usd) {
      cost.usd = call.attempt.estimate?.usd ?? 0;
    }
    const latencyMs = Math.round(performance.now() - start);
    const charge = this.store.transaction(() => {
      const cached = mode === 'cache' && !failure;
      this.store.finishLedger({ ...entry, ...cost, latencyMs, status: failure?.ledgerStatus ?? (cached ? 'cache_hit' : 'ok'),
        error: failure?.message });
      this.store.recordEvent(this.runId, {
        type: 'tool.result', callId, ok: !failure, latencyMs, credits: cost.credits, usd: cost.usd, cached, error: failure?.message,
      });
      const budget = this.store.budget(this.runId);
      const reason = budgetFailure?.reason ?? (mode === 'live' && budget.used.credits > budget.limits.maxCredits + 1e-9 ? 'credits'
        : mode === 'model' && budget.used.modelUsd > budget.limits.maxModelUsd + 1e-12 ? 'model_usd' : undefined);
      if (reason && !this.recheck) exhaust(this.store, this.runId, reason);
      else this.store.recordEvent(this.runId, { type: 'budget.update', budget });
      return reason;
    });
    // A successful data read stays available for evidence publication after a reported charge crosses the ceiling.
    if (charge && (mode !== 'live' || failure || this.recheck)) throw new BudgetError(charge);
    return { output, failure };
  }

}

export async function providerFetch(url: string | URL, request: RequestInit): Promise<Response> {
  try {
    return await fetch(url, request);
  } catch (error) {
    request.signal?.throwIfAborted();
    throw networkError(error);
  }
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new NonsenseError('Invalid JSON');
    throw networkError(error);
  }
}

async function withTimeout<T>(ms: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>,
  timeout: ToolError | BudgetError) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(timeout), ms);
  let rejectAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    return await Promise.race([run(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', rejectAbort);
  }
}
