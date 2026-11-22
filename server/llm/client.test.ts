import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const isolated = process.env.DOMINO_OPENAI_ADAPTER_TEST === '1';
const exec = promisify(execFile);

function adapterTest(name: string, check: () => void | Promise<void>) {
  if (isolated) {
    test(name, check);
    return;
  }
  // The provider is set at startup. Other Bun test files can already have loaded env.ts.
  test(name, async () => {
    await exec(process.execPath, ['test', '--test-name-pattern', name, fileURLToPath(import.meta.url)], {
      env: { ...process.env, DOMINO_OPENAI_ADAPTER_TEST: '1', OPENAI_API_KEY: 'sk-test-not-a-real-key',
        ANTHROPIC_API_KEY: '', OPENAI_MODEL: 'gpt-5-mini', OPENAI_REASONING_EFFORT: '', OPENAI_TIMEOUT_MS: '' },
    });
  });
}

const { Store } = await import('../db.ts');
const { defaultLimits } = await import('../env.ts');
const { ToolContext } = await import('../runtime/tool.ts');
const { modelClient, openaiReasoning } = await import('./client.ts');

const realFetch = globalThis.fetch;
let calls: { url: string; body: Record<string, unknown> }[] = [];
let store: InstanceType<typeof Store>;
let run = 0;

function mockFetch(respond: (signal: AbortSignal) => Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return respond(init!.signal!);
  }) as typeof fetch;
}

function context() {
  const id = `run_test_${++run}`;
  store.createRun(id, 'test request', 'fixture', 'openai:gpt-5-mini', defaultLimits, {});
  return new ToolContext(store, id, 'draft_messages');
}

const request = { purpose: 'draft', system: 'Write.', user: 'Draft one line.', maxTokens: 400, json: true } as const;

if (isolated) {
  beforeAll(() => { store = new Store(':memory:'); });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_TIMEOUT_MS;
  });
}

describe('openai adapter', () => {
  adapterTest('asks gpt-5 models for minimal reasoning and sends no unsupported sampling params', async () => {
    mockFetch(async () => Response.json({
      model: 'gpt-5-mini-2025-08-07',
      usage: { prompt_tokens: 40, completion_tokens: 20 },
      choices: [{ finish_reason: 'stop', message: { content: '{"subject":"Hi"}' } }],
    }));
    const ctx = context();
    const result = await modelClient(ctx).complete(request);
    expect(result).toEqual({ text: '{"subject":"Hi"}', model: 'openai:gpt-5-mini-2025-08-07' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].body).toMatchObject({ model: 'gpt-5-mini', reasoning_effort: 'minimal', max_completion_tokens: 400 });
    expect(calls[0].body).not.toHaveProperty('temperature');
    expect(calls[0].body).not.toHaveProperty('max_tokens');
    const [entry] = store.getLedger(ctx.runId);
    expect(entry).toMatchObject({ provider: 'openai', status: 'ok', inputTokens: 40, outputTokens: 20 });
    expect(entry.usd).toBeCloseTo((40 * 0.25 + 20 * 2) / 1e6, 12);
  });

  adapterTest('picks an effort each model family accepts', () => {
    expect(openaiReasoning('gpt-5-mini')).toEqual({ reasoning_effort: 'minimal' });
    expect(openaiReasoning('gpt-6-luna')).toEqual({ reasoning_effort: 'none' });
    expect(openaiReasoning('gpt-5-nano-2025-08-07')).toEqual({ reasoning_effort: 'minimal' });
    expect(openaiReasoning('gpt-5.4-mini')).toEqual({ reasoning_effort: 'low' });
    expect(openaiReasoning('gpt-4.1-mini')).toEqual({});
  });

  adapterTest('a 5xx retries once, then falls back to the template with every attempt in the ledger', async () => {
    mockFetch(async () => new Response('{"error":{"message":"overloaded"}}', { status: 503 }));
    const ctx = context();
    expect(await modelClient(ctx).complete(request)).toBeNull();
    expect(calls).toHaveLength(2);
    const ledger = store.getLedger(ctx.runId);
    expect(ledger.map(entry => [entry.status, entry.attempt])).toEqual([['error', 1], ['error', 2]]);
    const events = store.getEvents(ctx.runId, 0).map(stored => stored.event);
    expect(events.filter(event => event.type === 'tool.retry')).toHaveLength(1);
    expect(events.some(event => event.type === 'log' && /deterministic output/.test(event.message))).toBe(true);
  });

  adapterTest('a 400 is not retried', async () => {
    mockFetch(async () => new Response('{"error":{"code":"unsupported_parameter"}}', { status: 400 }));
    const ctx = context();
    expect(await modelClient(ctx).complete(request)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(store.getLedger(ctx.runId)).toHaveLength(1);
  });

  adapterTest('a timeout retries once and still charges the ledger for each aborted request', async () => {
    process.env.OPENAI_TIMEOUT_MS = '40';
    mockFetch(signal => new Promise<Response>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const ctx = context();
    expect(await modelClient(ctx).complete(request)).toBeNull();
    expect(calls).toHaveLength(2);
    const ledger = store.getLedger(ctx.runId);
    expect(ledger.map(entry => entry.status)).toEqual(['timeout', 'timeout']);
    for (const entry of ledger) expect(entry.usd).toBeGreaterThan(0);
    expect(store.budget(ctx.runId).used.modelUsd).toBeCloseTo(ledger[0].usd * 2, 12);
  });
});
