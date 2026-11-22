import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function checkAnthropic() {
  const dir = mkdtempSync(join(tmpdir(), 'domino-anthropic-test-'));
  let calls = 0;
  globalThis.fetch = (async (url: string | Request | URL, init?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(url, init);
    assert.match(request.url, /^https:\/\/api\.anthropic\.com\/v1\/messages(?:\?beta=true)?$/);
    assert.match(request.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    const body = await request.json() as Record<string, unknown>;
    assert.equal(body.model, 'claude-opus-5-5');
    assert.deepEqual(body.output_config, { effort: calls === 0 ? 'low' : 'medium' });
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.thinking, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'JSON input' }]);
    const refused = calls++ > 0;
    return Response.json({
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: 'ignored' }, { type: 'text', text: '{"buyerProfile":"AI companies"}' }],
      stop_reason: refused ? 'refusal' : 'end_turn',
      stop_details: refused ? { type: 'refusal', category: 'general_harms', explanation: 'fixture' } : null,
      usage: { input_tokens: 100, output_tokens: refused ? 0 : 20 },
    });
  }) as typeof fetch;
  const { Store } = await import('../db.ts');
  const { ToolContext } = await import('../runtime/tool.ts');
  const { modelClient } = await import('./client.ts');
  const store = new Store(join(dir, 'test.db'));
  try {
    const id = 'anthropic';
    store.createRun(id, 'Fixture test', 'fixture', 'anthropic:claude-opus-5-5', { maxCredits: 10, maxModelUsd: 1, maxSeconds: 30 }, {});
    const client = modelClient(new ToolContext(store, id, 'parse_request'));
    const params = { system: 'Return JSON', user: 'JSON input', maxTokens: 1024, json: true };
    assert.equal((await client.complete({ ...params, purpose: 'parse' }))?.text, '{"buyerProfile":"AI companies"}');
    assert.equal(await client.complete({ ...params, purpose: 'draft' }), null);
    assert.equal(calls, 2);
    assert.deepEqual(store.getLedger(id).map(row => [row.inputTokens, row.outputTokens, row.usd]), [[100, 20, 0.0008], [100, 0, 0]]);
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.env.DOMINO_ANTHROPIC_ADAPTER_TEST === '1') await checkAnthropic();
else test('Anthropic SDK uses Opus effort and server fallback and discards a final refusal', async () => {
  await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, DOMINO_ANTHROPIC_ADAPTER_TEST: '1', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: 'mock-anthropic-credential', ANTHROPIC_MODEL: 'claude-opus-5-5' },
  });
});
