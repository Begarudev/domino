// One Backend interface, two implementations: the real server (REST + SSE) and the in-browser mock.
import type { ChaosConfig, Evidence, RunLimits, RunSnapshot, StoredEvent } from '../../shared/types.ts';
import { emptySnapshot } from './state.ts';
import { buildScenario, scenarioFor } from './mock/events.ts';
import { MockRun } from './mock/player.ts';

export interface StartRequest { request: string; limits?: Partial<RunLimits>; chaos?: ChaosConfig }
export interface DecideResult { ok?: boolean; duplicate?: boolean }
export interface Health { ok: boolean; dataMode: string; crustdataKey: boolean; llm: string; version: string; cacheRows?: number; cacheFetchedAt?: string | null }

export interface Backend {
  mock: boolean;
  health: Health | null;
  startRun(req: StartRequest): Promise<{ id: string }>;
  loadRun(id: string): Promise<RunSnapshot>;
  subscribe(id: string, after: number, onEvents: (e: StoredEvent[]) => void, onConn?: (up: boolean) => void): () => void;
  kill(id: string): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  setLimits(id: string, limits: Partial<RunLimits>): Promise<unknown>;
  answer(id: string, askId: string, answer: string): Promise<unknown>;
  decide(approvalId: string, decision: 'approve' | 'reject'): Promise<DecideResult>;
  recheck(evidenceId: string, current: Evidence): Promise<Evidence>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain-text body */ }
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export function realBackend(health: Health): Backend {
  return {
    mock: false,
    health,
    startRun: (req) => post('/api/runs', req).then((r) => json<{ id: string }>(r)),
    loadRun: (id) => fetch(`/api/runs/${id}`).then((r) => json<RunSnapshot>(r)),
    subscribe(id, after, onEvents, onConn) {
      let last = after;
      let es: EventSource | null = null;
      let closed = false;
      let retry: ReturnType<typeof setTimeout> | null = null;
      const open = () => {
        if (closed) return;
        es = new EventSource(`/api/runs/${id}/stream?after=${last}`);
        es.onopen = () => onConn?.(true);
        es.onmessage = (m) => {
          try {
            const stored = JSON.parse(m.data) as StoredEvent;
            if (typeof stored.seq === 'number') last = Math.max(last, stored.seq);
            onEvents([stored]);
          } catch {
            /* heartbeat or malformed line: ignore */
          }
        };
        es.onerror = () => {
          onConn?.(false);
          es?.close();
          // Reopen from the last seq we applied (also covers servers that don't send `id:` lines).
          if (!closed) retry = setTimeout(open, 1000);
        };
      };
      open();
      return () => {
        closed = true;
        if (retry) clearTimeout(retry);
        es?.close();
      };
    },
    kill: (id) => post(`/api/runs/${id}/kill`).then((r) => json(r)),
    resume: (id) => post(`/api/runs/${id}/resume`).then((r) => json(r)),
    setLimits: (id, limits) => post(`/api/runs/${id}/limits`, limits).then((r) => json(r)),
    answer: (id, askId, answer) => post(`/api/runs/${id}/asks/${askId}`, { answer }).then((r) => json(r)),
    decide: (approvalId, decision) => post(`/api/approvals/${approvalId}`, { decision }).then((r) => json<DecideResult>(r)),
    recheck: (evidenceId) => post(`/api/evidence/${evidenceId}/recheck`).then((r) => json<Evidence>(r)),
  };
}

export function mockBackend(params: URLSearchParams): Backend {
  const runs = new Map<string, MockRun>();
  const speed = Number(params.get('speed') ?? '1') || 1;
  const instant = params.get('instant') === '1';
  const autoCrash = params.get('crash') !== '0';
  let n = 0;
  const get = (id: string) => {
    const r = runs.get(id);
    if (!r) throw new Error(`unknown mock run ${id}`);
    return r;
  };
  return {
    mock: true,
    health: { ok: true, dataMode: 'live', crustdataKey: false, llm: 'anthropic:claude-sonnet-5-5', version: 'mock' },
    async startRun(req) {
      const id = `run_mock_${++n}`;
      const scenario = buildScenario(scenarioFor(req.request), req.request, id);
      if (req.limits) Object.assign(scenario.limits, req.limits);
      const run = new MockRun(scenario, { speed, instant, autoCrash });
      runs.set(id, run);
      setTimeout(() => run.start(), 50);
      return { id };
    },
    async loadRun(id) {
      const run = get(id);
      const s = emptySnapshot(id, run.scenario.request);
      return { ...s, intent: run.scenario.intent, dataMode: run.scenario.dataMode, llm: run.scenario.llm, budget: { ...s.budget, limits: { ...run.scenario.limits } } };
    },
    subscribe(id, after, onEvents, onConn) {
      onConn?.(true);
      return get(id).subscribe(after, onEvents);
    },
    kill: async (id) => get(id).kill(),
    resume: async (id) => get(id).resume(),
    setLimits: async (id, limits) => get(id).setLimits(limits),
    answer: async (id, askId, answer) => get(id).answer(askId, answer),
    async decide(approvalId, decision) {
      for (const r of runs.values()) {
        const res = r.decide(approvalId, decision);
        if (res.ok) return res;
      }
      return { ok: false };
    },
    async recheck(_id, current) {
      const r = [...runs.values()].at(-1);
      await new Promise((ok) => setTimeout(ok, 600));
      return r ? r.recheck(current) : current;
    },
  };
}

/** `?mock=1` forces mock; otherwise mock is used when /api/health is unreachable. */
export async function pickBackend(): Promise<Backend> {
  const params = new URLSearchParams(location.search);
  if (params.get('mock') === '1') return mockBackend(params);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const health = (await res.json()) as Health;
    return realBackend(health);
  } catch {
    return mockBackend(params);
  }
}
