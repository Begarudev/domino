// The presenter overlay (caption bar + spotlight) and the /demo start card. Pointer events pass through everything
// except the caption's own controls, so the presenter can click the real app (e.g. Approve) themselves.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { STEPS, STEP_COUNT, back, exitDemo, next, startDemo, useDemo } from './store.ts';
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

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Keys while the demo runs: → / Space next, ← back, Esc exit. Space never reaches a focused button. */
function useDemoKeys(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
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
  useDemoKeys(active);
  const step = active ? STEPS[index] : undefined;
  const rect = useSpotlight(step);

  if (!active || !step) return null;
  const cue = step.cue;
  const pad = 8;
  const spot: CSSProperties | undefined = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : undefined;

  return (
    <div className="demo-layer" aria-live="polite">
      <div className={`demo-spot${spot ? ' on' : ''}`} style={spot} aria-hidden />
      <section className="demo-cap" role="region" aria-label="Presenter caption" data-testid="demo-caption">
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
            <span className="demo-step">Step {step.stepNo} of {STEP_COUNT}{step.beats > 1 ? ` · ${step.beat + 1}/${step.beats}` : ''}</span>
          </div>
        </div>
        <div className="demo-keys">
          <button className="demo-key" onClick={back} disabled={index === 0} aria-label="Previous step">←</button>
          <button className="demo-key" onClick={next} disabled={index === STEPS.length - 1} aria-label="Next step">→</button>
          <button className="demo-key wide" onClick={exitDemo}>Exit (Esc)</button>
        </div>
      </section>
    </div>
  );
}

/** /demo has no start card: opening it lands straight on step 1, its page and its caption. */
export function DemoBoot() {
  useEffect(() => { startDemo(); }, []);
  return null;
}
