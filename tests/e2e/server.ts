import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ChaosConfig, RunEvent, RunLimits, RunSnapshot, StoredEvent } from '../../shared/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = '127.0.0.1';
const runTimeout = 60_000;
const terminalStatuses = new Set(['completed', 'failed', 'crashed', 'budget_exhausted']);

export const inferenceRequest = 'We sell managed GPU inference. Find AI companies whose changes in the last 30 days mean they’ll need it, and book me meetings with the people who decide.';

async function freePort() {
  const socket = createServer();
  const listening = once(socket, 'listening');
  socket.listen(0, host);
  await listening;
  const address = socket.address();
  await new Promise<void>((resolve, reject) => {
    socket.close(error => error ? reject(error) : resolve());
  });
  assert(address && typeof address === 'object');
  return address.port;
}

export async function startServer(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'domino-e2e-'));
  const dbPath = join(dir, 'domino.db');
  const outboxPath = join(dir, 'outbox');
  let origin: string;
  let active: { child: ChildProcess; closed: Promise<void> } | undefined;

  async function stop() {
    if (!active) return;
    active.child.kill('SIGKILL');
    await active.closed;
    active = undefined;
  }

  t.after(async () => {
    try {
      await stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function start() {
    const port = await freePort();
    origin = `http://${host}:${port}`;
    const child = spawn(process.execPath, ['server/index.ts'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DOMINO_PORT: String(port), DOMINO_DB: dbPath, DOMINO_DATA: 'fixture', DOMINO_OUTBOX: outboxPath,
        // Empty values also prevent the startup .env loader from restoring keys.
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CRUSTDATA_API_KEY: '',
      },
    });
    let output = '';
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', error => { output += `\n${error.message}`; });
    active = { child, closed: new Promise<void>(resolve => child.once('close', () => resolve())) };

    const deadline = performance.now() + 10_000;
    while (child.pid && child.exitCode === null && child.signalCode === null && performance.now() < deadline) {
      const signal = AbortSignal.any([t.signal, AbortSignal.timeout(500)]);
      const response = await fetch(`${origin}/api/health`, { signal }).catch(() => undefined);
      if (response?.ok) {
        const health = await response.json();
        assert.equal(health.ok, true);
        assert.equal(health.dataMode, 'fixture');
        assert.equal(health.llm, 'template');
        assert.equal(health.crustdataKey, false);
        return;
      }
      await response?.body?.cancel();
      await delay(25, undefined, { signal: t.signal });
    }
    assert.fail(`DOMINO did not become healthy at ${origin}\n${output}`);
  }

  async function json<T>(path: string, body?: unknown, signal = t.signal): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    const payload = await response.text();
    assert(response.ok, `${body === undefined ? 'GET' : 'POST'} ${path} returned ${response.status}: ${payload}`);
    return JSON.parse(payload) as T;
  }

  async function createRun(request = inferenceRequest, options: { limits?: Partial<RunLimits>; chaos?: ChaosConfig } = {}) {
    const { id } = await json<{ id: string }>('/api/runs', { request, ...options });
    assert(id, 'POST /api/runs must return a run ID');
    return id;
  }

  const snapshot = (id: string, signal?: AbortSignal) => json<RunSnapshot>(`/api/runs/${id}`, undefined, signal);

  async function waitForSnapshot(id: string, expected: string, ready: (snapshot: RunSnapshot) => boolean) {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(runTimeout)]);
    let last: RunSnapshot | undefined;
    try {
      while (true) {
        last = await snapshot(id, signal);
        if (ready(last)) return last;
        const failedStep = last.steps.find(step => step.status === 'failed');
        assert(!terminalStatuses.has(last.status),
          `Run ${id} ended in ${last.status} while waiting for ${expected}${failedStep ? ` at ${failedStep.step}` : ''}`);
        await delay(40, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      assert.fail(`Run ${id} did not reach ${expected} within 60 seconds (last status: ${last?.status ?? 'unknown'})`);
    }
  }

  async function eventsThrough(id: string, matches: (event: RunEvent) => boolean, after = 0) {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(runTimeout)]);
    const response = await fetch(`${origin}/api/runs/${id}/stream?after=${after}`, { signal });
    assert(response.ok && response.body, `Run ${id} event stream returned ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const events: StoredEvent[] = [];
    let pending = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) assert.fail(`Run ${id} event stream closed before the expected event`);
        const frames = (pending + value).split(/\r?\n\r?\n/);
        pending = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const stored = JSON.parse(data) as StoredEvent;
          events.push(stored);
          if (matches(stored.event)) return events;
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      assert.fail(`Run ${id} event stream timed out after sequence ${events.at(-1)?.seq ?? after}`);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  await start();
  return {
    dbPath, outboxPath, json, createRun, snapshot, waitForSnapshot, eventsThrough,
    waitForStatus: (id: string, status: RunSnapshot['status']) => waitForSnapshot(id, status, run => run.status === status),
    async restart() {
      await stop();
      await start();
    },
  };
}
