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
  if (typeof value === 'string') return redactSecrets(value);
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

export class ToolError extends Error {
  readonly retry?: RetryReason;
  readonly ledgerStatus: LedgerEntry['status'];

  constructor(message: string, retry?: RetryReason, ledgerStatus: LedgerEntry['status'] = 'error') {
    super(message);
    this.retry = retry;
    this.ledgerStatus = ledgerStatus;
  }
}

export function httpError(status: number): ToolError {
  const retry = status === 429 ? 'rate_limit' : status >= 500 ? 'http_5xx' : undefined;
  return new ToolError(`Provider returned HTTP ${status}`, retry);
}

function classify(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof NonsenseError) return new ToolError('Provider response failed validation', 'nonsense', 'nonsense');
  return new ToolError('Tool call failed');
}

const zeroCost: Cost = { credits: 0, usd: 0, inputTokens: 0, outputTokens: 0 };
const timeoutError = new ToolError('Tool call timed out', 'timeout', 'timeout');
const garbage = { rows: '<<garbage>>' };

export function exhaust(store: Store, runId: string, reason: Exhausted, updateRun = true) {
  const budget = { ...store.budget(runId), exhausted: reason };
  if (updateRun && store.requireRun(runId).status !== 'budget_exhausted') {
    store.recordEvent(runId, { type: 'run.status', status: 'budget_exhausted', note: new BudgetError(reason).message });
  }
  store.recordEvent(runId, { type: 'budget.update', budget });
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
    try {
      await sleep(ms, undefined, { signal: this.signal });
    } catch (error) {
      this.signal?.throwIfAborted();
      throw error;
    }
  }

  assertTime() {
    this.signal?.throwIfAborted();
    if (this.recheck) return;
    const budget = this.store.budget(this.runId);
    if (budget.used.seconds >= budget.limits.maxSeconds) throw new BudgetError('seconds');
  }

  async tool<T>(call: Call<T>): Promise<T> {
    return this.attempts(call, randomUUID());
  }

  async crust<I, O>(
    spec: EndpointSpec<I, O>, input: I, time: Pick<ParseMeta, 'asOf' | 'windowDays'>,
    fixture: (path: string, body: unknown) => unknown,
  ): Promise<O> {
    const body = sanitize(spec.build(input));
    const request = canonicalJson(body);
    const key = hash(spec.path + request);
    const callId = randomUUID();
    const parse = (raw: unknown, mode: DataMode) => spec.parse(raw, input, {
      ...time, mode, endpoint: spec.path, retrievedAt: now(),
    });

    const run = (mode: DataMode, attempt: Attempt<O>['run'], estimate?: AttemptCost) => this.attempts({
      provider: 'crustdata', endpoint: spec.name, path: spec.path, body,
      attempt: { mode, run: attempt, inject: raw => parse(raw, mode), estimate, timeoutMs: 15_000 },
    }, callId);

    if (this.mode === 'live') {
      try {
        return await run('live', async (signal, report) => {
          if (!process.env.CRUSTDATA_API_KEY) throw new ToolError('Crustdata key unavailable');
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
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw httpError(response.status);
          }
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
    if (this.mode !== 'fixture') {
      try {
        return await run('cache', async () => {
          const raw = this.store.readCache(key);
          if (raw === undefined) throw new ToolError('Cache miss');
          return parse(raw, 'cache');
        });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        this.fallback(callId, spec.name, 'cache', 'fixture', error.message);
      }
    }
    return run('fixture', async () => {
      await this.wait(150 + Math.floor(Math.random() * 301));
      return parse(fixture(spec.path, body), 'fixture');
    });
  }

  private fallback(callId: string, endpoint: string, from: DataMode, to: DataMode, reason: string) {
    this.store.appendEvent(this.runId, { type: 'tool.fallback', callId, endpoint, from, to, reason });
  }

  private async attempts<T>(call: Call<T>, callId: string): Promise<T> {
    const { mode, estimate, timeoutMs = 12_000, maxAttempts = 3 } = call.attempt;
    const paid = mode === 'live' || mode === 'model';
    const requestHash = hash((call.path ?? call.endpoint) + canonicalJson(call.body));
    const chaos = this.recheck ? {} : decode<ChaosConfig>(this.store.requireRun(this.runId).chaos_json);
    let attempt = 0;
    for (;;) {
      attempt++;
      const matches = (names?: string[]) => names?.some(name => name === call.endpoint || name === call.path);
      const injectTimeout = attempt === 1 && Boolean(matches(chaos.timeoutOnce));
      const injectNonsense = attempt === 1 && !injectTimeout && Boolean(matches(chaos.nonsenseOnce));
      // An injected failure applies once per call even when that call falls back to another mode.
      const injected = mode === this.mode || mode === 'model' ? injectTimeout || injectNonsense : false;
      let blocked: Exhausted | undefined;
      const entry = this.store.transaction(() => {
        const budget = this.store.budget(this.runId);
        if (!this.recheck && (this.signal?.aborted || budget.used.seconds >= budget.limits.maxSeconds)) blocked = 'seconds';
        if (!blocked && mode === 'live' && (budget.used.credits >= budget.limits.maxCredits
          || budget.used.credits + (estimate?.credits ?? 0) > budget.limits.maxCredits + 1e-9)) blocked = 'credits';
        if (!blocked && mode === 'model' && (budget.used.modelUsd >= budget.limits.maxModelUsd
          || budget.used.modelUsd + (estimate?.usd ?? 0) > budget.limits.maxModelUsd + 1e-12)) blocked = 'model_usd';
        const row = this.store.beginLedger({
          ...zeroCost, ...(!blocked && paid && !injected ? estimate : {}),
          runId: this.runId, step: this.step, provider: call.provider, endpoint: call.endpoint,
          mode, status: blocked ? 'budget_blocked' : 'error', attempt, latencyMs: 0, injected: injected && !blocked,
        }, requestHash);
        if (blocked) {
          this.store.finishLedger(row);
          const run = this.store.requireRun(this.runId);
          exhaust(this.store, this.runId, blocked, !this.recheck || run.engine_pid !== null);
        } else {
          this.store.recordEvent(this.runId, { type: 'tool.call', callId, provider: call.provider, endpoint: call.endpoint, mode, attempt });
        }
        return row;
      });
      if (blocked) throw new BudgetError(blocked);

      const start = performance.now();
      const cost = { ...zeroCost };
      let output: T | undefined;
      let failure: ToolError | undefined;
      let budgetFailure: BudgetError | undefined;
      try {
        if (injected && injectTimeout) {
          await this.wait(1200);
          throw timeoutError;
        }
        output = injected ? call.attempt.inject(garbage) : await withTimeout(timeoutMs, this.signal, signal =>
          call.attempt.run(signal, reported => Object.assign(cost, reported)));
      } catch (error) {
        budgetFailure = error instanceof BudgetError ? error : undefined;
        failure = budgetFailure ? timeoutError : classify(error);
      }
      // An aborted model request keeps generating, and billing, on the provider side. With no usage to read,
      // charge the estimate so the ledger and the budget still count it.
      if (mode === 'model' && !injected && failure?.retry === 'timeout' && !budgetFailure && !cost.usd) {
        cost.usd = estimate?.usd ?? 0;
      }
      const latencyMs = Math.round(performance.now() - start);
      const charge = this.store.transaction(() => {
        const cached = mode === 'cache' && !failure;
        this.store.finishLedger({ ...entry, ...cost, latencyMs, status: failure?.ledgerStatus ?? (cached ? 'cache_hit' : 'ok') });
        this.store.recordEvent(this.runId, {
          type: 'tool.result', callId, ok: !failure, latencyMs, credits: cost.credits, usd: cost.usd, cached,
        });
        const budget = this.store.budget(this.runId);
        const reason = budgetFailure?.reason ?? (mode === 'live' && budget.used.credits > budget.limits.maxCredits + 1e-9 ? 'credits'
          : mode === 'model' && budget.used.modelUsd > budget.limits.maxModelUsd + 1e-12 ? 'model_usd' : undefined);
        if (reason) exhaust(this.store, this.runId, reason, !this.recheck || this.store.requireRun(this.runId).engine_pid !== null);
        else this.store.recordEvent(this.runId, { type: 'budget.update', budget });
        return reason;
      });
      if (charge) throw new BudgetError(charge);
      if (!failure) return output as T;
      if (!failure.retry || attempt >= maxAttempts || (mode === 'cache' && !injected)) throw failure;
      const backoffMs = 180 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      this.store.appendEvent(this.runId, {
        type: 'tool.retry', callId, endpoint: call.endpoint, reason: failure.retry, attempt, backoffMs, injected,
      });
      await this.wait(backoffMs);
    }
  }
}

export async function providerFetch(url: string | URL, request: RequestInit): Promise<Response> {
  try {
    return await fetch(url, request);
  } catch {
    request.signal?.throwIfAborted();
    throw new ToolError('Provider network failure', 'network');
  }
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new NonsenseError('Invalid JSON');
    throw new ToolError('Provider response interrupted', 'network');
  }
}

async function withTimeout<T>(ms: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(timeoutError), ms);
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
