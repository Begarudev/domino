// Landing and request box. Everything shown after "Start the run" comes from the real run snapshot:
// the plan is snapshot.steps (server labels), the cap is snapshot.budget.limits, the window is snapshot.intent.
import { useEffect, useRef, useState } from 'react';
import type { RunSnapshot, StepState } from '../../../../shared/types.ts';
import { STEP_ORDER } from '../../../../shared/types.ts';
import type { StartRequest } from '../../api.ts';
import { addDays, fmtDate } from '../../dates.ts';
import './landing.css';

const OUTBOUND =
  "We sell managed GPU inference. Find AI companies whose changes in the last 30 days mean they'll need it, and book me meetings with the people who decide.";
const REPLAY =
  'Replay as of 1 Sep 2026: we sell managed GPU inference. Which AI companies would have needed it, and were we right by 22 Nov?';
const EXAMPLES = [
  { label: 'This week’s meetings', text: OUTBOUND },
  { label: 'Replay from 1 Sep', text: REPLAY },
];

// Stage 0 idle, 1 plan lit, 2 cap shown, 3 window shown, 4 leaving.
type Stage = 0 | 1 | 2 | 3 | 4;

export interface LandingProps {
  snap: RunSnapshot;
  runId: string | null;
  error: string | null;
  dataMode: string | null;
  reducedMotion: boolean;
  onStart: (req: StartRequest) => void;
  onDone: () => void;
}

const finished = (s: StepState) => s.status === 'done' || s.status === 'skipped';

export function Landing({ snap, runId, error, dataMode, reducedMotion, onStart, onDone }: LandingProps) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [stage, setStage] = useState<Stage>(0);
  const [fallen, setFallen] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const hold = new URLSearchParams(location.search).get('hold') === '1';
  const t = (ms: number) => (reducedMotion ? Math.min(ms, 120) : ms);

  useEffect(() => { box.current?.focus(); }, []);
  // A failed start returns the box to the user.
  useEffect(() => { if (error && submitted && !runId) setSubmitted(false); }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = submitted && !!runId && snap.id === runId;
  const steps = live ? snap.steps : [];
  const intent = live ? snap.intent : null;
  const limits = live ? snap.budget.limits : null;

  // Reveal in order, each beat gated on the real data being present.
  useEffect(() => {
    if (!live) return;
    if (stage === 0 && steps.length) { const h = setTimeout(() => setStage(1), t(250)); return () => clearTimeout(h); }
    if (stage === 1) { const h = setTimeout(() => setStage(2), t(steps.length * 70 + 500)); return () => clearTimeout(h); }
    if (stage === 2 && intent) { const h = setTimeout(() => setStage(3), t(700)); return () => clearTimeout(h); }
  }, [live, stage, steps.length, !!intent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tiles fall one at a time behind the real step.completed / step.skipped events.
  const doneCount = steps.findIndex((s) => !finished(s));
  const target = doneCount === -1 ? steps.length : doneCount;
  useEffect(() => {
    if (stage < 2 || fallen >= target) return;
    const h = setTimeout(() => setFallen((f) => f + 1), t(170));
    return () => clearTimeout(h);
  }, [stage, fallen, target]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hand off once the window is shown and the first tiles have gone; sooner if the run needs the user.
  const needsUser = live && (snap.status === 'awaiting_input' || snap.status === 'failed' || snap.status === 'budget_exhausted');
  useEffect(() => {
    if (hold || stage === 4) return;
    if (stage === 3 || (needsUser && stage >= 1)) {
      const h = setTimeout(() => setStage(4), t(needsUser ? 900 : 2600));
      return () => clearTimeout(h);
    }
  }, [stage, needsUser, hold]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stage !== 4) return;
    const h = setTimeout(onDone, t(950));
    return () => clearTimeout(h);
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    const request = text.trim();
    if (!request || submitted) return;
    setSubmitted(true);
    setStage(0);
    setFallen(0);
    // Same injected faults as the shell's Run button, so the retry shows in the timeline (labelled injected).
    onStart({ request, chaos: { timeoutOnce: ['job_search'], nonsenseOnce: ['company_growth'] } });
  };

  const tiles = steps.length ? steps : STEP_ORDER.map((step) => ({ step, label: '', status: 'pending' as const, attempt: 0 }));
  const running = steps.find((s) => s.status === 'running');
  const windowStart = intent ? addDays(intent.asOf, -intent.windowDays) : null;
  const replay = intent?.runKind === 'replay';
  const fixture = (live ? snap.dataMode : dataMode) === 'fixture';

  return (
    <div className={`ld${submitted ? ' ld--run' : ''}${stage === 4 ? ' ld--leave' : ''}${reducedMotion ? ' ld--still' : ''}`} role="region" aria-label="Start a run">
      <div className="ld-lamp" aria-hidden="true" />
      <header className="ld-top">
        <span className="ld-mark">DOMINO</span>
        {(live ? snap.dataMode : dataMode) && (
          <span className={`ld-mode${fixture ? ' ld-mode--fixture' : ''}`}>
            {fixture ? 'Fixture data: synthetic companies' : `Data: ${live ? snap.dataMode : dataMode}`}
          </span>
        )}
      </header>

      <section className="ld-ask">
        <h1 className="ld-title">Who should you meet this week?</h1>
        <p className="ld-sub">DOMINO reads the last month of hires, job posts and funding across companies, works out who now needs what you sell, and drafts a sourced note to the person who decides.</p>

        <form className="ld-card" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <label htmlFor="ld-req" className="sr-only">What do you sell, and who should DOMINO find?</label>
          <textarea
            id="ld-req" ref={box} rows={3} value={text} spellCheck={false} readOnly={submitted}
            placeholder="What do you sell, and who should DOMINO find meetings with?"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); } }}
          />
          <div className="ld-card-foot">
            {submitted ? (
              <span className="ld-stamp" aria-live="polite">
                {runId ? <>Run started <span className="ld-mono">{runId.replace(/^run_/, '').slice(0, 8)}</span></> : 'Starting the run'}
              </span>
            ) : (
              <div className="ld-examples" role="group" aria-label="Example requests">
                {EXAMPLES.map((ex) => (
                  <button key={ex.label} type="button" className={`ld-ex${text === ex.text ? ' is-on' : ''}`}
                    onClick={() => { setText(ex.text); box.current?.focus(); }}>{ex.label}</button>
                ))}
              </div>
            )}
            <button type="submit" className="ld-go" disabled={!text.trim() || submitted}>
              {submitted ? 'Running' : 'Start the run'}
              {!submitted && <kbd className="ld-kbd" aria-hidden="true">⌘↵</kbd>}
            </button>
          </div>
        </form>
        {error && !runId && <p className="ld-error" role="alert">{error}</p>}
      </section>

      <section className={`ld-plan${stage >= 1 ? ' is-lit' : ''}`} aria-label="Plan">
        <div className="ld-plan-head">
          <h2 className="ld-h">{stage >= 1 ? 'The plan' : `${STEP_ORDER.length} steps from your request to an approved meeting`}</h2>
          {stage >= 1 && <span className="ld-now" aria-live="polite">{running ? running.label : target === steps.length ? 'Every step done' : 'Queued'}</span>}
        </div>
        <ol className="ld-row">
          {tiles.map((s, i) => (
            <li key={s.step} style={{ ['--i' as string]: i }}
              className={`ld-tile${i < fallen ? ' is-down' : ''}${s.status === 'running' ? ' is-up' : ''}${s.status === 'skipped' ? ' is-skip' : ''}${s.status === 'failed' ? ' is-fail' : ''}`}>
              <span className="ld-tile-n">{i + 1}</span>
              <span className="ld-tile-rule" aria-hidden="true" />
              <span className="ld-tile-label">{s.label}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="ld-terms" aria-label="Run limits and window">
        <div className={`ld-term ld-term--cap${stage >= 2 ? ' is-in' : ''}`}>
          <h2 className="ld-h">Credit cap</h2>
          {limits && (
            <p className="ld-fig">
              <span className="ld-big">{limits.maxCredits}</span><span className="ld-unit">Crustdata credits</span>
              <span className="ld-small">plus ${limits.maxModelUsd.toFixed(2)} of model spend. The run stops before any call that would go over.</span>
            </p>
          )}
        </div>
        <div className={`ld-term ld-term--win${stage >= 3 ? ' is-in' : ''}`}>
          <h2 className="ld-h">{replay ? 'Frozen at' : 'Window'}</h2>
          {intent && windowStart && (
            <p className="ld-fig">
              {replay ? (
                <>
                  <span className="ld-big">{fmtDate(intent.asOf)}</span><span className="ld-unit">{intent.asOf.slice(0, 4)}</span>
                  <span className="ld-small">Only facts dated on or before this day. Scored against what happened up to {fmtDate(intent.horizonEnd, { year: true })}.</span>
                </>
              ) : (
                <>
                  <span className="ld-big">{intent.windowDays}</span><span className="ld-unit">days</span>
                  <span className="ld-small">Changes dated {fmtDate(windowStart)} to {fmtDate(intent.asOf, { year: true })}.</span>
                </>
              )}
            </p>
          )}
        </div>
        <div className={`ld-term ld-term--clock${stage >= 2 ? ' is-in' : ''}`}>
          <h2 className="ld-h">Time limit</h2>
          {limits && (
            <p className="ld-fig">
              <span className="ld-big">{limits.maxSeconds >= 60 && limits.maxSeconds % 60 === 0 ? limits.maxSeconds / 60 : limits.maxSeconds}</span>
              <span className="ld-unit">{limits.maxSeconds >= 60 && limits.maxSeconds % 60 === 0 ? 'minutes' : 'seconds'}</span>
              <span className="ld-small">Wall-clock limit for the whole run.</span>
            </p>
          )}
        </div>
        {stage >= 1 && stage < 4 && (
          <button type="button" className="ld-skip" onClick={() => setStage(4)}>Open the run</button>
        )}
      </section>
    </div>
  );
}

/** Show the landing on a fresh visit; `?run=ID` or `?landing=0` goes straight to the run view. */
export function landingWanted(): boolean {
  const p = new URLSearchParams(location.search);
  if (p.get('landing') === '1') return true;
  return !p.get('run') && p.get('landing') !== '0' && p.get('mock') !== '1';
}
