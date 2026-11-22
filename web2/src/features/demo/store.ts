// Presenter mode (/demo): steps through the real app routes with a caption bar and a spotlight on top.
// SAFETY: this module only navigates and reads. It never clicks, submits or POSTs anything; beats that spend or send
// (Run, Recheck, Approve, onboarding a new URL) are cued for the presenter to do by hand.
import { useSyncExternalStore } from 'react';
import rawSteps from './steps.json';
import { runStore } from '../../data/store.ts';
import { signInCandidate, signInCompany } from '../../shell/ui.ts';

/** The steps file as pres-4min writes it (times may be seconds or "m:ss"; focus is the presenter's prose). */
interface RawStep {
  id: string; start: number | string; end: number | string; speaker: 'A' | 'B'; line: string;
  route: string | null; focus?: string | null; criterion?: string; cue?: string;
}
/** One screen of a step. A step that covers two screens has two beats; → moves through beats, then steps. */
export interface DemoStep {
  id: string;
  stepNo: number;           // 1-based step number (beats of one step share it)
  beat: number;             // 0-based beat within the step
  beats: number;
  start: number;            // seconds into the talk, for this beat
  end: number;
  speaker: 'A' | 'B';
  line: string;
  route: string | null;     // app path (+ query); null keeps the current page
  focus: string | null;     // a CSS selector list, tried in order (first visible wins)
  note: string | null;      // the steps file's own description of what is on screen
  criterion?: string;
  cue: string | null;       // an instruction for the presenter (never acted on by the overlay)
}

const RUN = 'run_2a38d6d8-217d-45e7-8c30-29a7c6d4ec46'; // full id: the short id 404s
const SELL_RUN = 'run_1a165a3d-5c87-43dc-aedb-9307e98f9973';
/** Where each step looks. Selectors are existing data-testids, ordered so the spotlight follows the screen's state. */
const DIRECTION: Record<string, { route?: string; focus: string; cue?: string }[]> = {
  hook: [{ focus: '.rec-op' }],
  opening: [{ focus: '.rec-op' }, { focus: '[data-testid="funnel"]' }, { focus: '[data-testid="hire-panel"]' }],
  approve: [{
    focus: '[data-testid="approve"], [data-testid="resume"], [data-testid="approve-retry"], [data-testid="deliveries"], [data-testid="outreach-draft"]',
    cue: 'Presenter: click Approve, then Resume from checkpoint. It delivers once; the overlay never clicks.',
  }],
  // Buyers pins its run from ?buyers= (prefix match), not ?run=; pin the full id so the page never picks another run.
  sell: [{ route: `/company/abacus-ai/buyers?buyers=${SELL_RUN}`, focus: '.by-t, [data-testid^="buyer-row-"]' }],
  verifier: [{ focus: '[data-testid="guard-card"]' }, { route: '/company/abacus-ai/reading', focus: '[data-testid="reading-chart"], [data-testid="reading-row"]' }],
  'replay-ledger': [
    { focus: '[data-testid="replay-summary"], [data-testid="replay-protocol"]' },
    { route: `/company/abacus-ai/ledger?run=${RUN}`, focus: '[data-testid="blocked-call"], [data-testid="cap-line"]' },
  ],
  architecture: [{ focus: '[data-testid="cap-line"], .lg-table' }],
  close: [{ focus: '.rec-op' }],
};

const secs = (v: number | string) => {
  if (typeof v === 'number') return v;
  const [m, s] = v.split(':').map(Number);
  return s === undefined ? m : m * 60 + s;
};
const isSelector = (f: string) => /^[.#[]/.test(f);

export const STEPS: DemoStep[] = (rawSteps as RawStep[]).flatMap((r, i) => {
  const start = secs(r.start), end = secs(r.end);
  const route = r.route ? r.route.replace(/^https?:\/\/[^/]+/, '') : null;
  const plan = DIRECTION[r.id] ?? [{ focus: r.focus && isSelector(r.focus) ? r.focus : '' }];
  const len = (end - start) / plan.length;
  return plan.map((b, k) => ({
    id: plan.length > 1 ? `${r.id}.${k + 1}` : r.id, stepNo: i + 1, beat: k, beats: plan.length,
    start: Math.round(start + k * len), end: Math.round(start + (k + 1) * len),
    speaker: r.speaker, line: r.line, route: b.route ?? route, focus: b.focus || null,
    note: r.focus && !isSelector(r.focus) ? r.focus : null, criterion: r.criterion,
    cue: r.cue ?? b.cue ?? null,
  }));
});
export const STEP_COUNT = rawSteps.length;
export const DEMO_COMPANY = { id: 'cd:632052', name: 'Abacus.AI' };

/** Presenter-paced: no clock, no autoplay. Only the active flag and the step index persist (sessionStorage). */
interface DemoState { active: boolean; index: number }

const KEY = 'domino.v2.demo';
const initial: DemoState = { active: false, index: 0 };
let state: DemoState = (() => { try { const v = JSON.parse(sessionStorage.getItem(KEY) ?? '{}'); return { active: !!v.active, index: Number(v.index) || 0 }; } catch { return initial; } })();
const listeners = new Set<() => void>();
function set(patch: Partial<DemoState>) {
  state = { ...state, ...patch };
  sessionStorage.setItem(KEY, JSON.stringify(state));
  document.documentElement.classList.toggle('demo-on', state.active);
  listeners.forEach((f) => f());
}
document.documentElement.classList.toggle('demo-on', state.active);

export const getDemo = () => state;
export function useDemo<T>(sel: (s: DemoState) => T): T {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => sel(state));
}

/** Navigate the real app to a step's route, signed in as the side that route belongs to. */
function go(step: DemoStep, replace = false) {
  (document.activeElement as HTMLElement | null)?.blur?.(); // a focused button must never catch a Space press
  if (!step.route) return;
  const path = step.route.split('?')[0];
  if (path.startsWith('/candidate')) signInCandidate();
  else if (path.startsWith('/company')) signInCompany(DEMO_COMPANY.id, DEMO_COMPANY.name);
  if (location.pathname + location.search !== step.route) {
    if (replace) history.replaceState(null, '', step.route); else history.pushState(null, '', step.route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  const run = new URLSearchParams(step.route.split('?')[1] ?? '').get('run');
  if (run && run.length > 30 && runStore.backend && runStore.get().runId !== run) void runStore.attach(run); // read-only load of a finished run (full ids only; short ids 404)
}

/** Opening /demo starts at step 1. The /demo entry is replaced, so browser Back never lands on it and restarts. */
export function startDemo() {
  set({ active: true, index: 0 });
  go(STEPS[0], true);
}
export function goTo(index: number) {
  if (!state.active) return;
  const i = Math.max(0, Math.min(STEPS.length - 1, index));
  set({ index: i });
  go(STEPS[i]);
}
export const next = () => goTo(state.index + 1);
export const back = () => goTo(state.index - 1);
export const exitDemo = () => set({ ...initial });
