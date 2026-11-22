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
import { API_ERROR, MAX_REQUEST_CHARS } from '../shared/types.ts';
import type { Pipeline, RunEvent, RunLimits, RunStatus } from '../shared/types.ts';
import { ApprovalError, pendingKeys, reserveApproval } from './actions/outbox.ts';
import { decode, Store } from './db.ts';
import type { RunChaos } from './db.ts';
import { companyDossier } from './desk/dossier.ts';
import { rulesRegistry } from './desk/rules.ts';
import { deskRoutes } from './desk/routes.ts';
import { recheckSource } from './engine/sources.ts';
import { config, defaultLimits, redactSecrets, root } from './env.ts';
import { cacheStats, importCache } from './runtime/cache-snapshot.ts';
import { BudgetError, ToolContext, ToolError } from './runtime/tool.ts';
import { isAlive, snapshot } from './snapshot.ts';

const worker = new URL('./engine/worker.ts', import.meta.url);
const dispatcher = new URL('./actions/dispatch-worker.ts', import.meta.url);
const active = new Set<RunStatus>(['queued', 'running', 'awaiting_input', 'awaiting_approval']);
const limitsSchema = z.object({
  maxCredits: z.number().finite().nonnegative(),
  maxModelUsd: z.number().finite().nonnegative(),
  maxSeconds: z.number().finite().nonnegative(),
}).partial().strict();
const chaosSchema = z.object({
  timeoutOnce: z.array(z.string()).max(20).optional(), nonsenseOnce: z.array(z.string()).max(20).optional(),
  crashAfterDeliver: z.boolean().optional(),
});
const runSchema = z.object({
  request: z.string().trim().min(1).max(MAX_REQUEST_CHARS),
  limits: limitsSchema.optional(), chaos: chaosSchema.optional(),
  dataMode: z.enum(['live', 'cache', 'fixture']).optional(),
  pipeline: z.enum(['outbound', 'openings', 'candidate', 'intro']).optional(),
});
const missingWeb = '<!doctype html><html lang="en"><title>DOMINO</title><p>The UI is not built yet: run <code>bun start</code> (it builds the UI), or <code>bun run build:web2</code>.</p></html>';

export function createApp(store: Store) {
  const app = new Hono();
  const children = new Map<string, ChildProcess>();
  const deliveries = new Map<string, { pid?: number; delivered: Promise<boolean> }>();

  function startDelivery(runId: string, key: string) {
    const existing = deliveries.get(key);
    if (existing) return existing;
    const child = fork(dispatcher, [], {
      cwd: root, env: { ...process.env, DOMINO_DELIVERY_KEY: key, CRUSTDATA_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    const delivered = new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (signal?: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        deliveries.delete(key);
        const row = store.sql.prepare('SELECT status FROM outbox WHERE idempotency_key = ?').get(key);
        if (row?.status !== 'delivered') {
          const chaos = decode<RunChaos>(store.requireRun(runId).chaos_json);
          const injected = signal === 'SIGKILL' && chaos.crashAfterDeliver &&
            store.sql.prepare('SELECT 1 FROM inbox_received WHERE idempotency_key = ?').get(key);
          store.appendEvent(runId, { type: 'log', level: 'warn', message: injected
            ? 'Injected dispatcher SIGKILL after the test inbox accepted the message. Retry delivery to recover the receipt.'
            : 'Dispatch interrupted. Retry the approval or resume the run to check the test inbox.' });
        }
        resolve(row?.status === 'delivered');
      };
      child.once('error', () => finish());
      child.once('exit', (_code, signal) => finish(signal));
    });
    const delivery = { pid: child.pid, delivered };
    deliveries.set(key, delivery);
    return delivery;
  }

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
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
        });
        child.stderr?.on('data', chunk => process.stderr.write(redactSecrets(String(chunk))));
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
    console.error(redactSecrets(error.stack ?? String(error)));
    return c.json({ error: 'The request could not be completed' }, 500);
  });
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
    // Privacy boundary: every JSON response shows people as role + initial; full names never leave the server.
    if (c.res.headers.get('content-type')?.includes('application/json')) {
      const body = await c.res.clone().json().catch(() => undefined);
      if (body !== undefined) {
        c.res = new Response(JSON.stringify(store.redactor.value(body)), { status: c.res.status, headers: c.res.headers });
      }
    }
  });

  app.get('/api/health', c => c.json({
    ok: true, dataMode: config.dataMode, crustdataKey: config.crustdataKey, llm: config.llm,
    version: '0.1.0', ...cacheStats(store),
  }));

  function launch(pipeline: Pipeline, request: string, options: {
    limits?: Partial<RunLimits>; dataMode?: 'live' | 'cache' | 'fixture'; chaos?: z.infer<typeof chaosSchema>;
  } = {}): string {
    const { dataMode, limits, chaos } = options;
    const id = `run_${randomUUID()}`;
    store.createRun(id, redactSecrets(request), dataMode ?? config.dataMode, config.llmLabel, { ...defaultLimits, ...limits }, {
      timeoutOnce: chaos?.timeoutOnce?.map(redactSecrets), nonsenseOnce: chaos?.nonsenseOnce?.map(redactSecrets),
      ...chaos?.crashAfterDeliver && { crashAfterDeliver: true },
    }, pipeline);
    startWorker(id, false);
    return id;
  }

  app.post('/api/runs', async c => {
    const body = runSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected a request and valid optional limits, chaos, and dataMode' }, 400);
    const { request, dataMode, limits, chaos, pipeline } = body.data;
    return c.json({ id: launch(pipeline ?? 'outbound', request, { dataMode, limits, chaos }) }, 201);
  });

  // Full company analysis for one company (lead-owned; see docs/CONTRACT.md "Company dossier").
  app.get('/api/companies/:id/dossier', c => {
    const result = store.transaction(() => companyDossier(store, c.req.param('id'), c.req.query('run') || undefined), 'read');
    return result ? c.json(result) : c.json({ error: 'No analysis run has this company yet' }, 404);
  });
  // Rules registry: statements, thresholds, guards, lock times and live fire counts (lead-owned).
  app.get('/api/rules', c => c.json(store.transaction(() => rulesRegistry(store), 'read')));
  app.route('/api', deskRoutes({ store, launch }));

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
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(store.redactor.value(event)) });
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
    const workerPid = startWorker(id, true);
    const deliveryPids = pendingKeys(store, id).map(key => startDelivery(id, key).pid);
    const pid = workerPid ?? deliveryPids.find(Boolean);
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
    const result = reserveApproval(store, c.req.param('id'), body.data.decision);
    if (!result) return c.json({ error: 'Approval not found' }, 404);
    const { approval, status } = result;
    if (status === 'rejected') return c.json({ approval });
    if (status === 'delivered') return c.json({ duplicate: true });

    const key = approval.idempotencyKey;
    const joined = deliveries.has(key);
    const finished = await startDelivery(approval.runId, key).delivered;
    if (!finished) return c.json({ pending: true, approval }, 202);
    if (joined) {
      store.appendEvent(approval.runId, { type: 'action.duplicate_blocked', approvalId: approval.id,
        idempotencyKey: key, note: 'This approval was already being dispatched' });
      return c.json({ duplicate: true });
    }
    const action = store.getOutbox(approval.runId).find(action => action.idempotencyKey === key);
    const row = store.sql.prepare(`SELECT payload_json FROM events WHERE run_id = ? AND type = 'delivery.receipt'
      AND json_extract(payload_json, '$.approvalId') = ? ORDER BY seq DESC LIMIT 1`).get(approval.runId, approval.id);
    const receipt = row && decode<Extract<RunEvent, { type: 'delivery.receipt' }>>(row.payload_json as string).receipt;
    return c.json({ approval: store.getApproval(approval.id), action, receipt });
  });

  app.post('/api/evidence/:id/recheck', async c => {
    const row = store.findEvidence(c.req.param('id'));
    if (!row?.source) return c.json({ error: 'Evidence source not found' }, 404);
    const ctx = new ToolContext(store, row.runId, 'evidence.recheck', { recheck: true });
    const updated = await recheckSource(ctx, row.evidence, row.source);
    return updated ? c.json(updated) : c.json({ error: 'Evidence record was absent in the latest source response' }, 404);
  });

  app.all('/api/*', c => c.json({ error: 'API route not found', code: API_ERROR.routeMissing }, 404));
  // The original run view, built with base /classic/ (bun run build:classic), stays reachable at /classic.
  const classic = resolve(root, 'web/dist-classic');
  if (existsSync(resolve(classic, 'index.html'))) {
    app.get('/classic', c => c.redirect('/classic/', 302));
    app.get('/classic/*', serveStatic({ root: classic, rewriteRequestPath: path => path.replace(/^\/classic/, '') }),
      serveStatic({ path: resolve(classic, 'index.html') }));
  }
  // The DOMINO app (web2/: sign-in, candidate and company sides) is the main UI. DOMINO_UI=web serves the original run
  // view at / instead; it is also always at /classic once built.
  const dist = resolve(root, process.env.DOMINO_UI === 'web' ? 'web/dist' : 'web2/dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.get('*', serveStatic({ root: dist }), serveStatic({ path: resolve(dist, 'index.html') }));
  }
  app.get('*', c => c.html(missingWeb));
  return { app, reapMissingWorkers, launch };
}

export function startServer() {
  const store = new Store();
  importCache(store);
  const { app, reapMissingWorkers, launch } = createApp(store);
  reapMissingWorkers();
  // A keyless first start has nothing to show: one scan of the labelled fixture world (0 credits, a few seconds) fills
  // both the candidate and the company side. Live and cache servers never scan on their own.
  const scanned = store.sql.prepare("SELECT 1 FROM runs WHERE pipeline = 'openings' LIMIT 1").get();
  if (config.dataMode === 'fixture' && !scanned) {
    launch('openings', 'Predict openings in inference, ML platform, MLOps and GPU/LLM infrastructure roles', { dataMode: 'fixture' });
  }
  const timer = setInterval(reapMissingWorkers, 1000).unref();
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, ({ port }) => {
    console.log(`DOMINO http://127.0.0.1:${port} · data ${config.dataMode} · LLM ${config.llm}`);
  });
  server.on('close', () => { clearInterval(timer); store.sql.close(); });
  return server;
}

export function portError(error: NodeJS.ErrnoException): never {
  const busy = error.code === 'EADDRINUSE';
  console.error(busy
    ? `DOMINO could not start: port ${config.port} is already in use. Try another port: DOMINO_PORT=${config.port + 1} bun start`
    : `DOMINO could not bind port ${config.port} (${error.code ?? error.message}).`);
  process.exit(1);
}

if (import.meta.main) {
  startServer().on('error', portError);
}
