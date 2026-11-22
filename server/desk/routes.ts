// Search Desk HTTP API. OWNER: domino-desk-api (candidate + company endpoints); openings data comes from the latest
// openings-pipeline run (OWNER: domino-livedata). Contract: shared/desk.ts + docs/CONTRACT.md "Search Desk".
import { Hono } from 'hono';
import type { Pipeline, RunLimits } from '../../shared/types.ts';
import type { Store } from '../db.ts';

export interface DeskDeps {
  store: Store;
  // Creates a run of the given pipeline and forks its engine worker; returns the run id.
  launch(pipeline: Pipeline, request: string, options?: { limits?: Partial<RunLimits>; dataMode?: 'live' | 'cache' | 'fixture' }): string;
}

export function deskRoutes({ store, launch }: DeskDeps) {
  const api = new Hono();
  // Start an openings scan: { request?: string, replay?: { asOf } } -> { runId }
  api.post('/openings/scan', async c => {
    const body = await c.req.json().catch(() => ({})) as { request?: string };
    const runId = launch('openings', body.request?.trim() || 'Predict openings in inference, ML platform, MLOps and GPU/LLM infrastructure roles');
    return c.json({ runId }, 201);
  });
  api.get('/companies', c => c.json([]));
  void store;
  return api;
}
