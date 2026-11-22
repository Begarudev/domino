import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { RunLimits, RunStatus } from '../shared/types.ts';
import { ApprovalError, decideApproval, recoverOutbox } from './actions/outbox.ts';
import { decode, Store } from './db.ts';
import { recheckSource } from './engine/sources.ts';
import { config, defaultLimits, redactSecrets, root } from './env.ts';
import { cacheStats, importCache } from './runtime/cache-snapshot.ts';
import { BudgetError, ToolContext, ToolError } from './runtime/tool.ts';
import { isAlive, snapshot } from './snapshot.ts';

const worker = new URL('./engine/worker.ts', import.meta.url);
const active = new Set<RunStatus>(['queued', 'running', 'awaiting_input', 'awaiting_approval']);
const limitsSchema = z.object({
  maxCredits: z.number().finite().nonnegative(),
  maxModelUsd: z.number().finite().nonnegative(),
  maxSeconds: z.number().finite().nonnegative(),
}).partial().strict();
const chaosSchema = z.object({ timeoutOnce: z.array(z.string()).max(20).optional(), nonsenseOnce: z.array(z.string()).max(20).optional() });
const runSchema = z.object({
  request: z.string().trim().min(1).max(12_000),
  limits: limitsSchema.optional(), chaos: chaosSchema.optional(),
  dataMode: z.enum(['live', 'cache', 'fixture']).optional(),
});
const missingWeb = '<!doctype html><html lang="en"><title>DOMINO</title><p>run npm run build:web</p></html>';

export function createApp(store: Store) {
  const app = new Hono();
  const children = new Map<string, ChildProcess>();

  function recordCrash(id: string, pid: number | null, signal: string | null) {
    store.transaction(() => {
      const run = store.getRun(id);
      if (!run || run.engine_pid !== pid || !active.has(run.status) ||
          (run.status === 'awaiting_approval' && pid === null)) return;
      const atStep = store.getSteps(id).find(row => row.status === 'running')?.step ?? null;
      store.sql.prepare('UPDATE runs SET crashes = crashes + 1, engine_pid = NULL WHERE id = ?').run(id);
      store.recordEvent(id, { type: 'engine.crashed', pid: pid ?? 0, atStep, signal });
      store.recordEvent(id, { type: 'run.status', status: 'crashed' });
    });
  }

  function reapMissingWorkers() {
    const rows = store.sql.prepare(`SELECT id, engine_pid AS pid FROM runs WHERE status IN ('running', 'awaiting_input', 'queued')
      OR (status = 'awaiting_approval' AND engine_pid IS NOT NULL)`).all();
    for (const row of rows) {
      const id = row.id as string;
      const pid = row.pid as number | null;
      if (!children.has(id) && !isAlive(pid)) recordCrash(id, pid, null);
    }
  }

  function startWorker(id: string, resume: boolean): number | undefined {
    let child: ChildProcess | undefined;
    let pid: number | undefined;
    try {
      pid = store.transaction(() => {
        const run = store.requireRun(id);
        if (children.has(id) || isAlive(run.engine_pid)) return;
        if (resume ? !['crashed', 'budget_exhausted'].includes(run.status) : run.status !== 'queued') return;
        child = fork(worker, [], {
          cwd: root, env: { ...process.env, RUN_ID: id },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
        });
        child.on('error', () => {
          if (children.get(id) === child) children.delete(id);
          recordCrash(id, pid ?? null, null);
        });
        child.once('exit', (code, signal) => {
          if (children.get(id) === child) children.delete(id);
          if (code !== 0 || signal || store.getRun(id)?.engine_pid === pid) recordCrash(id, pid ?? null, signal);
        });
        if (!child.pid) throw new Error('Worker process could not start');
        store.sql.prepare('UPDATE runs SET engine_pid = ?, resumes = resumes + ? WHERE id = ?').run(child.pid, Number(resume), id);
        if (resume) store.recordEvent(id, { type: 'run.status', status: 'queued' });
        children.set(id, child);
        return child.pid;
      });
      return pid;
    } catch {
      child?.kill();
      recordCrash(id, null, null);
      return;
    }
  }

  app.onError((error, c) => {
    if (error instanceof ApprovalError) return c.json({ error: error.message }, 409);
    if (error instanceof BudgetError) return c.json({ error: error.message }, 409);
    if (error instanceof ToolError) return c.json({ error: error.message }, 502);
    return c.json({ error: 'The request could not be completed' }, 500);
  });
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/api/health', c => c.json({
    ok: true, dataMode: config.dataMode, crustdataKey: config.crustdataKey, llm: config.llm,
    version: '0.1.0', ...cacheStats(store),
  }));

  app.post('/api/runs', async c => {
    const body = runSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected a request and valid optional limits, chaos, and dataMode' }, 400);
    const { request, dataMode, limits, chaos } = body.data;
    const id = `run_${randomUUID()}`;
    store.createRun(id, redactSecrets(request), dataMode ?? config.dataMode, config.llmLabel, { ...defaultLimits, ...limits }, {
      timeoutOnce: chaos?.timeoutOnce?.map(redactSecrets), nonsenseOnce: chaos?.nonsenseOnce?.map(redactSecrets),
    });
    startWorker(id, false);
    return c.json({ id }, 201);
  });

  app.get('/api/runs', c => c.json(store.listRuns()));

  app.get('/api/runs/:id', c => {
    const id = c.req.param('id');
    const result = store.transaction(() => store.getRun(id) && snapshot(store, id), 'read');
    return result ? c.json(result) : c.json({ error: 'Run not found' }, 404);
  });

  app.get('/api/runs/:id/stream', c => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'Run not found' }, 404);
    const cursor = (value?: string) => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
    let after = Math.max(cursor(c.req.query('after')), cursor(c.req.header('Last-Event-ID')));
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async stream => {
      let heartbeat = Date.now();
      while (!stream.aborted) {
        const events = store.getEvents(id, after);
        for (const event of events) {
          if (stream.aborted) break;
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          after = event.seq;
        }
        if (Date.now() - heartbeat >= 10_000) {
          await stream.write(': heartbeat\n\n');
          heartbeat = Date.now();
        }
        if (events.length < 256) await stream.sleep(150);
      }
    });
  });

  app.post('/api/runs/:id/kill', c => {
    const id = c.req.param('id');
    const run = store.getRun(id);
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const child = children.get(id);
    const pid = run.engine_pid;
    const killed = Boolean(pid && child?.pid === pid && child.kill('SIGKILL'));
    return c.json({ killed, pid });
  });

  app.post('/api/runs/:id/resume', c => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'Run not found' }, 404);
    const pid = startWorker(id, true);
    return pid ? c.json({ pid }) : c.json({ error: 'Run cannot be resumed in its current state' }, 409);
  });

  app.post('/api/runs/:id/limits', async c => {
    const id = c.req.param('id');
    if (!store.getRun(id)) return c.json({ error: 'Run not found' }, 404);
    const body = limitsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected valid nonnegative run limits' }, 400);
    const budget = store.transaction(() => {
      const limits = { ...decode<RunLimits>(store.requireRun(id).limits_json), ...body.data };
      store.sql.prepare('UPDATE runs SET limits_json = ? WHERE id = ?').run(JSON.stringify(limits), id);
      const budget = store.budget(id);
      store.recordEvent(id, { type: 'budget.update', budget });
      return budget;
    });
    return c.json({ limits: budget.limits, budget });
  });

  app.post('/api/runs/:id/asks/:askId', async c => {
    const { id, askId } = c.req.param();
    const body = z.object({ answer: z.string().trim().min(1).max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected a nonempty answer' }, 400);
    return store.transaction(() => {
      const ask = store.getAsk(id, askId);
      if (!ask) return c.json({ error: 'Question not found' }, 404);
      const answer = redactSecrets(body.data.answer);
      if (ask.answer === answer) return c.json({ ask });
      if (ask.answer || !['awaiting_input', 'crashed'].includes(store.requireRun(id).status)) {
        return c.json({ error: 'This question is closed' }, 409);
      }
      store.recordEvent(id, { type: 'ask.answered', askId, answer });
      return c.json({ ask: { ...ask, answer } });
    });
  });

  app.post('/api/approvals/:id', async c => {
    const body = z.object({ decision: z.enum(['approve', 'reject']) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected decision approve or reject' }, 400);
    const result = decideApproval(store, c.req.param('id'), body.data.decision);
    return result ? c.json(result) : c.json({ error: 'Approval not found' }, 404);
  });

  app.post('/api/evidence/:id/recheck', async c => {
    const row = store.findEvidence(c.req.param('id'));
    if (!row?.source) return c.json({ error: 'Evidence source not found' }, 404);
    const ctx = new ToolContext(store, row.runId, 'evidence.recheck', { recheck: true });
    const updated = await recheckSource(ctx, row.evidence, row.source);
    return updated ? c.json(updated) : c.json({ error: 'Evidence record was absent in the latest source response' }, 404);
  });

  app.all('/api/*', c => c.json({ error: 'API route not found' }, 404));
  const dist = resolve(root, 'web/dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.get('*', serveStatic({ root: dist }), serveStatic({ path: resolve(dist, 'index.html') }));
  }
  app.get('*', c => c.html(missingWeb));
  return { app, reapMissingWorkers };
}

export function startServer() {
  const store = new Store();
  importCache(store);
  recoverOutbox(store);
  const { app, reapMissingWorkers } = createApp(store);
  reapMissingWorkers();
  const timer = setInterval(reapMissingWorkers, 1000).unref();
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, ({ port }) => {
    console.log(`DOMINO http://127.0.0.1:${port} · data ${config.dataMode} · LLM ${config.llm}`);
  });
  server.on('close', () => { clearInterval(timer); store.sql.close(); });
  return server;
}

if (import.meta.main) {
  startServer().on('error', () => {
    console.error('DOMINO could not bind the server port.');
    process.exit(1);
  });
}
