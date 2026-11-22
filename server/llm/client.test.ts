import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'domino-llm-test-'));
process.env.DOMINO_DB = join(dir, 'test.db');
process.env.OPENAI_API_KEY = 'mock-openai-credential';
process.env.ANTHROPIC_API_KEY = 'mock-anthropic-credential';
process.env.OPENAI_MODEL = 'configured-openai-model';
const { Store } = await import('../db.ts');
const { config } = await import('../env.ts');
const { ToolContext } = await import('../runtime/tool.ts');
const { modelClient } = await import('./client.ts');
const store = new Store();
const completion = {
  purpose: 'parse' as const, system: 'Return JSON', user: 'Testing model calls', maxTokens: 1024, json: true,
};

function create(id: string) {
  store.createRun(id, 'Fixture test', 'fixture', config.llmLabel, { maxCredits: 10, maxModelUsd: 1, maxSeconds: 30 }, {});
  return modelClient(new ToolContext(store, id, 'parse_request'));
}

after(() => {
  store.sql.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OpenAI takes precedence and uses Chat Completions with estimated pricing for a custom model', async t => {
  assert.equal(config.llm, 'openai');
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer mock-openai-credential');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'configured-openai-model');
    assert.equal(body.max_completion_tokens, 1024);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '{"buyerProfile":"AI companies"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    });
  });
  const client = create('completed');
  const result = await client.complete(completion);
  assert.equal(result?.text, '{"buyerProfile":"AI companies"}');
  assert.equal(fetch.mock.callCount(), 1);
  const [entry] = store.getLedger('completed');
  assert.equal(entry.provider, 'openai');
  assert.equal(entry.endpoint, 'configured-openai-model (estimated)');
  assert.equal(entry.inputTokens, 100);
  assert.equal(entry.outputTokens, 40);
  assert.equal(entry.usd, (100 * 0.25 + 40 * 2.00) / 1_000_000);
});

for (const status of [400, 404]) {
  test(`OpenAI model_not_found at HTTP ${status} disables calls for that run with one warning`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error: { code: 'model_not_found', message: 'mock-openai-credential' } }, { status }));
    const id = `missing-${status}`;
    assert.equal(await create(id).complete(completion), null);
    const later = modelClient(new ToolContext(store, id, 'draft_messages'));
    assert.equal(await later.complete({ ...completion, purpose: 'draft' }), null);
    assert.equal(await later.complete({ ...completion, purpose: 'draft' }), null);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(store.getLedger(id).length, 1);
    assert.equal(store.requireRun(id).llm, 'template');
    const events = store.getEvents(id, 0);
    assert.equal(events.filter(row => row.event.type === 'log' && row.event.level === 'warn').length, 1);
    assert(!JSON.stringify(events).includes('mock-openai-credential'));
  });
}
