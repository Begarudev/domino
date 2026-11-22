// The presenter overlay (caption bar + spotlight) and the /demo start card. Pointer events pass through everything
// except the caption's own controls, so the presenter can click the real app (e.g. Approve) themselves.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  PLAN_SECONDS, STEPS, STEP_COUNT, back, elapsedSeconds, exitDemo, getDemo, next, startDemo, toggleAutoplay, useDemo,
} from './store.ts';
import type { DemoStep } from './store.ts';
import './demo.css';

/** The step's focus is a selector list in priority order: the first part with a visible match wins, so the
    spotlight follows the screen (Approve, then Resume, then Deliveries) as the presenter clicks. */
function findTarget(focus: string | null): HTMLElement | null {
  if (!focus) return null;
  for (const part of focus.split(',')) {
    try {
      for (const el of document.querySelectorAll<HTMLElement>(part.trim())) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    } catch { /* a bad selector just means no spotlight */ }
  }
  return null;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const planTitle = () => `DOMINO · ${Math.round(PLAN_SECONDS / 60)}-minute walkthrough`;

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Keys while the demo runs: → / Space next, ← back, P autoplay, Esc exit. Space never reaches a focused button. */
function useDemoKeys(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggleAutoplay(); }
      else if (e.key === 'Escape') { e.preventDefault(); exitDemo(); }
    };
    const up = (e: KeyboardEvent) => { if (e.key === ' ' && !isTyping(e.target)) e.preventDefault(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [active]);
}

/** Re-measure the focus target while the step is up (pages load their data after the route changes). */
function useSpotlight(step: DemoStep | undefined) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    setRect(null);
    if (!step?.focus) return;
    let scrolled = false;
    const tick = () => {
      const el = findTarget(step.focus);
      if (!el) { setRect(null); return; }
      if (!scrolled) { scrolled = true; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      const r = el.getBoundingClientRect();
      setRect((prev) => (prev && Math.abs(prev.top - r.top) < 1 && Math.abs(prev.left - r.left) < 1 && Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1 ? prev : r));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [step?.id, step?.focus]);
  return rect;
}

export function DemoOverlay() {
  const active = useDemo((s) => s.active);
  const index = useDemo((s) => s.index);
  const autoplay = useDemo((s) => s.autoplay);
  const paused = useDemo((s) => s.pausedAt !== null);
  const [, setNow] = useState(0);
  useDemoKeys(active);
  const step = active ? STEPS[index] : undefined;
  const rect = useSpotlight(step);

  // One clock for the timer and autoplay. Autoplay dwells for the step's planned length, then moves on.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      const s = getDemo();
      const cur = STEPS[s.index];
      if (s.autoplay && cur && Date.now() - s.stepEnteredAt >= (cur.end - cur.start) * 1000) next();
    }, 250);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active || !step) return null;
  const elapsed = elapsedSeconds();
  const late = elapsed > step.end + 2;
  const cue = step.cue;
  const pad = 8;
  const spot: CSSProperties | undefined = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : undefined;

  return (
    <div className="demo-layer" aria-live="polite">
      <div className={`demo-spot${spot ? ' on' : ''}`} style={spot} aria-hidden />
      <section className="demo-cap" role="region" aria-label="Presenter caption" data-testid="demo-caption">
        <div className="demo-progress" aria-hidden><span style={{ width: `${Math.min(100, (elapsed / PLAN_SECONDS) * 100)}%` }} /></div>
        <div className="demo-cap-in">
          <div className="demo-speaker" title={`Speaker ${step.speaker}`}>
            <span className={`demo-chip sp-${step.speaker}`}>{step.speaker}</span>
          </div>
          <div className="demo-copy">
            <p className="demo-line" key={step.stepNo}>{step.line}</p>
            {cue && <p className="demo-cue" data-testid="demo-cue">{cue}</p>}
          </div>
          <div className="demo-meta">
            {step.criterion && <span className="ctag demo-crit">{step.criterion}</span>}
            <span className={`demo-clock${late ? ' late' : ''}`} title={`Planned ${mmss(step.start)}–${mmss(step.end)}`}>
              <b>{mmss(elapsed)}</b> / {mmss(PLAN_SECONDS)}
            </span>
            <span className="demo-step">Step {step.stepNo} of {STEP_COUNT}{step.beats > 1 ? ` · ${step.beat + 1}/${step.beats}` : ''}{autoplay ? ' · auto' : paused ? ' · paused' : ''}</span>
          </div>
        </div>
        <div className="demo-keys">
          <button className="demo-key" onClick={back} disabled={index === 0} aria-label="Previous step">←</button>
          <button className="demo-key" onClick={next} disabled={index === STEPS.length - 1} aria-label="Next step">→</button>
          <button className="demo-key wide" onClick={toggleAutoplay}>{autoplay ? 'Pause (P)' : 'Autoplay (P)'}</button>
          <button className="demo-key wide" onClick={exitDemo}>Exit (Esc)</button>
        </div>
      </section>
    </div>
  );
}

export function DemoStart() {
  const speakers = (['A', 'B'] as const).map((sp) => ({ sp, steps: STEPS.filter((s) => s.speaker === sp) }))
    .filter((x) => x.steps.length);
  const criteria = [...new Set(STEPS.map((s) => s.criterion).filter(Boolean))] as string[];
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (getDemo().active || isTyping(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); startDemo(false); }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  return (
    <div className="demo-start" data-testid="demo-start">
      <h1>{planTitle()}</h1>
      <p className="demo-sub">The real app, step by step, in time with the talk. Nothing is clicked for you: anything that sends or spends is yours to press.</p>
      <div className="demo-cols">
        <div>
          <h2>Speakers</h2>
          <ul className="demo-list">
            {speakers.map(({ sp, steps }) => (
              <li key={sp}><span className={`demo-chip sm sp-${sp}`}>{sp}</span> Speaker {sp} <span className="faint">· {new Set(steps.map((s) => s.stepNo)).size} steps, {mmss(steps.reduce((t, s) => t + s.end - s.start, 0))}</span></li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Criteria covered</h2>
          <ul className="demo-list">
            {criteria.map((c) => <li key={c}><span className="ctag">{c}</span></li>)}
          </ul>
        </div>
      </div>
      <div className="demo-actions">
        <button className="btn primary" onClick={() => startDemo(false)} data-testid="demo-go" autoFocus>Start <span className="faint-on">→ or Space</span></button>
        <button className="btn" onClick={() => startDemo(true)}>Start with autoplay</button>
      </div>
      <p className="demo-help">→ or Space next · ← back · P autoplay · Esc exit. Signs in as {`Abacus.AI`} or the sample candidate as each step needs.</p>
    </div>
  );
}
