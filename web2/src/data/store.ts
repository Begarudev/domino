// The v2 run store. It reuses the web app's reducer and backend unchanged (web/src/state.ts, web/src/api.ts) and
// adds what v2 needs for smoothness:
//  - incoming events are queued and flushed once per requestAnimationFrame, with a ~6 ms work budget per frame;
//  - a burst of CATCH_UP or more events in one flush is "catch-up": features render it settled, not animated;
//  - sample playback is paced by a rAF clock (real gaps compressed), never by setTimeout per event;
//  - feeds (activity cards, narration) are folded incrementally and append-only.
// Components subscribe with useRunSel(selector), so a panel re-renders only when its slice changes.
import { useEffect, useSyncExternalStore } from 'react';
import type { RunLimits, RunSnapshot, StoredEvent } from '../../../shared/types.ts';
import type { Backend, Health } from '../../../web/src/api.ts';
import { mockBackend, realBackend } from '../../../web/src/api.ts';
import { emptySnapshot, initialState, reduce, uiReducer } from '../../../web/src/state.ts';
import type { UIState } from '../../../web/src/state.ts';
import { emptyFeeds, foldFeeds } from './derive.ts';
import type { Feeds } from './derive.ts';

export type Mode = 'live' | 'sample' | 'mock';

export interface RunView {
  mode: Mode;
  health: Health | null;
  runId: string | null;
  ui: UIState;                 // reducer state from web/src/state.ts (snap, timeline, receipts, ...)
  feeds: Feeds;
  connected: boolean;
  error: string | null;
  /** true while the current flush is a backlog (attach to a finished run, or a burst) */
  catchingUp: boolean;
  /** queued events not yet applied (sample playback or a burst being paced) */
  pending: number;
  /** sample playback */
  playing: boolean;
  /** bumps on every applied flush */
  version: number;
}

const CATCH_UP = 24;
const FRAME_BUDGET_MS = 6;

type Listener = () => void;

function initialView(mode: Mode): RunView {
  return {
    mode, health: null, runId: null, ui: initialState(emptySnapshot('', '')), feeds: emptyFeeds(), connected: true,
    error: null, catchingUp: false, pending: 0, playing: false, version: 0,
  };
}

export class RunStore {
  private view: RunView;
  private listeners = new Set<Listener>();
  private queue: StoredEvent[] = [];
  private raf = 0;
  private unsub: (() => void) | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  // sample playback clock
  private script: { at: number; ev: StoredEvent }[] = [];
  private scriptIdx = 0;
  private clock = 0;          // ms of playback elapsed
  private lastFrame = 0;
  private speed = 1;
  backend: Backend | null = null;

  constructor(mode: Mode) {
    this.view = initialView(mode);
  }

  get = () => this.view;
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  private set(patch: Partial<RunView>) {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- setup

  async init(params: URLSearchParams) {
    const mode = this.view.mode;
    this.speed = Number(params.get('speed') ?? '1') || 1;
    if (mode === 'mock') {
      this.backend = mockBackend(params);
      this.set({ health: this.backend.health });
      return;
    }
    if (mode === 'sample') return; // sample needs no backend: the events come from docs/sample-run-events.json
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch('/api/health', { signal: ctrl.signal });
      clearTimeout(t);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('json')) throw new Error(`health ${res.status}`);
      const health = (await res.json()) as Health;
      this.backend = realBackend(health);
      this.set({ health, error: null });
    } catch (e) {
      this.set({ error: `The DOMINO server isn't answering at /api (${(e as Error).message}). Start it with: bun run serve` });
    }
  }

  // ---------------------------------------------------------------- live runs

  async attach(runId: string, opts: { paced?: boolean } = {}) {
    if (!this.backend) return;
    this.detach();
    let snap: RunSnapshot;
    try {
      snap = await this.backend.loadRun(runId);
    } catch (e) {
      this.set({ error: `Couldn't load run ${runId.slice(0, 12)}: ${(e as Error).message}` });
      return;
    }
    this.set({ runId, ui: initialState(snap), feeds: emptyFeeds(), error: null, version: this.view.version + 1 });
    if (opts.paced) {
      // Replay a finished run at watchable pace: collect its events, then play them through the sample clock.
      const collected: StoredEvent[] = [];
      let idle: ReturnType<typeof setTimeout> | null = null;
      const stop = this.backend.subscribe(runId, 0, (evs) => {
        collected.push(...evs);
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => { stop(); this.loadScript(collected); this.play(); }, 400);
      }, (up) => this.set({ connected: up }));
      this.unsub = stop;
      return;
    }
    this.unsub = this.backend.subscribe(runId, 0, (evs) => this.enqueue(evs), (up) => this.set({ connected: up }));
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    this.queue = [];
    this.script = [];
    this.scriptIdx = 0;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Forget the current run (the rail goes back to its empty state). */
  clear() {
    this.detach();
    this.set({ runId: null, ui: initialState(emptySnapshot('', '')), feeds: emptyFeeds(), pending: 0, playing: false, catchingUp: false });
  }

  async startRun(request: string, limits?: Partial<RunLimits>) {
    if (!this.backend) throw new Error('No server');
    const { id } = await this.backend.startRun({ request, limits });
    await this.attach(id);
    return id;
  }

  private enqueue(evs: StoredEvent[]) {
    this.queue.push(...evs);
    this.schedule();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    // sample clock: release every scripted event whose time has come
    if (this.view.playing && this.script.length) {
      const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
      this.lastFrame = now;
      this.clock += dt * this.speed;
      while (this.scriptIdx < this.script.length && this.script[this.scriptIdx].at <= this.clock) {
        this.queue.push(this.script[this.scriptIdx].ev);
        this.scriptIdx++;
      }
      if (this.scriptIdx >= this.script.length) this.view = { ...this.view, playing: false };
    }
    if (this.queue.length) this.flush();
    if (this.queue.length || this.view.playing) this.schedule();
    else this.lastFrame = 0;
  };

  private flush() {
    const t0 = performance.now();
    const catchingUp = this.queue.length >= CATCH_UP;
    let ui = this.view.ui;
    const applied: StoredEvent[] = [];
    // Apply as many as fit in the frame budget; the rest wait for the next frame.
    while (this.queue.length && (performance.now() - t0 < FRAME_BUDGET_MS || applied.length === 0)) {
      const ev = this.queue.shift()!;
      const next = reduce(ui, ev);
      if (next === ui) continue; // already applied (reconnect replay or a duplicate subscription)
      ui = next;
      applied.push(ev);
    }
    if (!applied.length) return;
    const feeds = foldFeeds(this.view.feeds, applied, ui.snap);
    const pending = this.queue.length + (this.script.length - this.scriptIdx);
    this.set({ ui, feeds, catchingUp, pending, version: this.view.version + 1 });
    // The server snapshot is authoritative: refetch it once we've caught up after a status/step change.
    if (this.view.mode === 'live' && this.view.runId && !this.queue.length &&
      applied.some((e) => e.event.type === 'run.status' || e.event.type === 'step.completed')) {
      if (this.refetchTimer) clearTimeout(this.refetchTimer);
      const id = this.view.runId;
      this.refetchTimer = setTimeout(() => {
        this.backend?.loadRun(id).then((s) => {
          if (this.view.runId === id && !this.queue.length) this.set({ ui: uiReducer(this.view.ui, { type: 'snapshot', snap: s }) });
        }).catch(() => {});
      }, 300);
    }
  }

  // ---------------------------------------------------------------- sample playback

  /** Pace a recorded event list: real gaps compressed (max 1.2 s), visible events at least 40 ms apart. */
  loadScript(events: StoredEvent[]) {
    const VISIBLE = new Set(['source.read', 'trigger.found', 'graph.edge', 'draft.ready', 'target.held', 'step.started', 'tool.retry', 'decider.found']);
    let at = 0;
    let prevTs = events.length ? Date.parse(events[0].ts) : 0;
    this.script = events.map((ev) => {
      const ts = Date.parse(ev.ts);
      const gap = Math.max(0, Math.min(1200, ts - prevTs));
      prevTs = ts;
      at += Math.max(gap, VISIBLE.has(ev.event.type) ? 40 : 0);
      return { at, ev };
    });
    this.scriptIdx = 0;
    this.clock = 0;
    this.set({ pending: this.script.length });
  }

  async loadSample() {
    const mod = await import('../../../docs/sample-run-events.json');
    const data = (mod.default ?? mod) as unknown as { request: string; note: string; events: StoredEvent[] };
    const runId = data.events[0]?.runId ?? 'sample';
    const snap = { ...emptySnapshot(runId, data.request), dataMode: 'live' as const };
    this.detach();
    this.set({ runId, ui: initialState(snap), feeds: emptyFeeds(), error: null });
    this.loadScript(data.events);
    return data;
  }

  play() {
    if (!this.script.length) return;
    this.lastFrame = 0;
    this.set({ playing: true });
    this.schedule();
  }

  pause() {
    this.set({ playing: false });
  }

  setSpeed(n: number) {
    this.speed = n;
  }

  // ---------------------------------------------------------------- actions (live server or mock)

  kill = () => (this.backend && this.view.runId ? this.backend.kill(this.view.runId) : Promise.resolve(null));
  resume = () => (this.backend && this.view.runId ? this.backend.resume(this.view.runId) : Promise.resolve(null));
  setLimits = (limits: Partial<RunLimits>) => (this.backend && this.view.runId ? this.backend.setLimits(this.view.runId, limits) : Promise.resolve(null));
  decide = (approvalId: string, decision: 'approve' | 'reject') => (this.backend ? this.backend.decide(approvalId, decision) : Promise.resolve({ ok: false }));
}

export function modeFromUrl(params: URLSearchParams): Mode {
  const m = params.get('mode');
  if (m === 'sample' || m === 'mock') return m;
  if (params.get('mock') === '1') return 'mock';
  return 'live';
}

export const runStore = new RunStore(modeFromUrl(new URLSearchParams(location.search)));

/** Subscribe to one slice of the run view. Return a stable value (a field, not a fresh object) to avoid re-renders. */
export function useRunSel<T>(sel: (v: RunView) => T): T {
  return useSyncExternalStore(runStore.subscribe, () => sel(runStore.get()));
}

export const useSnap = () => useRunSel((v) => v.ui.snap);

/**
 * Scope the activity rail and the meters to the run behind the page in view (the candidate's enrich run, the
 * company's latest scan). null clears them, so a page never shows an unrelated run's activity. Sample and mock
 * sessions keep their own run.
 */
export function useRunScope(runId: string | null | undefined) {
  useEffect(() => {
    const v = runStore.get();
    if (v.mode !== 'live') return;
    if (!runId) { if (v.runId) runStore.clear(); return; }
    if (v.runId !== runId) void runStore.attach(runId);
  }, [runId]);
}
