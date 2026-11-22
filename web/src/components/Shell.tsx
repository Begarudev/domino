// App shell pieces: the landing title card, the top bar, and the run reel (steps as a filmstrip).
// Feature panels (request box, drawer, drafts, ledger, ...) plug into this shell; it owns only layout.
import type { ReactNode } from 'react';
import type { RunSnapshot, StepName } from '../../../shared/types.ts';
import type { UIState } from '../state.ts';

const SHORT: Record<StepName, string> = {
  parse_request: 'Read request', pull_triggers: 'Pull triggers', resolve_entities: 'Resolve names',
  enrich_companies: 'Enrich', cascade: 'Cascade', rank_targets: 'Rank', find_deciders: 'Deciders',
  warm_paths: 'Warm paths', draft_messages: 'Draft + verify', approval_gate: 'Approval', score_replay: 'Score replay',
};

export function Landing(props: { requestBar: ReactNode; source: ReactNode }) {
  return (
    <section className="landing film" aria-label="Start a run">
      <div className="landing-inner m-establish">
        <h1 className="landing-title">DOMINO</h1>
        <p className="landing-lead">
          A dated change at one company creates a need at another. DOMINO finds that second domino, proves it with dated
          sources, and books the meeting once you approve.
        </p>
        <div className="landing-request">{props.requestBar}</div>
        <div className="landing-source">{props.source}</div>
      </div>
    </section>
  );
}

export function Reel(props: { state: UIState; onKill: () => void; onResume: () => void; busy: string | null; onOpenLog: () => void }) {
  const { snap, timeline, durations } = props.state;
  const steps = snap.steps.filter((s) => !(s.step === 'score_replay' && snap.intent?.runKind !== 'replay'));
  const canKill = snap.status === 'running' && snap.engine.alive !== false;
  const canResume = snap.status === 'crashed';
  return (
    <nav className="reel" aria-label="Run steps">
      <ol className="reel-frames">
        {steps.map((s, i) => {
          const items = timeline.filter((t) => t.step === s.step);
          const retries = items.filter((t) => t.tone === 'retry' || t.tone === 'warn').length;
          const crashed = items.some((t) => t.rule && t.tone === 'fail');
          const resumed = items.some((t) => t.rule && t.tone === 'engine');
          const ms = durations[s.step];
          return (
            <li key={s.step} className={`frame frame-${s.status}${s.resumedFromCheckpoint ? ' is-reused' : ''}${crashed ? ' is-cut' : ''}`}>
              <button type="button" className="frame-btn" onClick={props.onOpenLog} title={s.summary ?? s.label}>
                <span className="frame-n">{i + 1}</span>
                <span className="frame-label">{SHORT[s.step]}</span>
                <span className="frame-meta">
                  {s.resumedFromCheckpoint ? 'reused' : s.status === 'running' ? 'now' : ms != null ? (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`) : ''}
                </span>
                <span className="frame-marks" aria-hidden="true">
                  {retries > 0 && <span className="mk mk-retry">{retries}</span>}
                  {crashed && <span className="mk mk-cut">killed</span>}
                  {resumed && <span className="mk mk-resume">resumed</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="reel-engine">
        <EngineText snap={snap} />
        {canResume ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={props.onResume} disabled={props.busy === 'resume'}>Resume from checkpoint</button>
        ) : (
          <button type="button" className="btn btn-danger btn-sm" onClick={props.onKill} disabled={!canKill || props.busy === 'kill'} title="SIGKILL the engine process mid-step">Crash engine</button>
        )}
      </div>
    </nav>
  );
}

function EngineText({ snap }: { snap: RunSnapshot }) {
  const e = snap.engine;
  if (!e.pid && !e.crashes) return null;
  return (
    <span className="reel-pid">
      Engine {e.alive ? 'running' : 'stopped'}{e.pid ? <>, pid <b>{e.pid}</b></> : null}
      {e.crashes ? `, ${e.crashes} crash${e.crashes > 1 ? 'es' : ''}` : ''}{e.resumes ? `, ${e.resumes} resumed` : ''}
    </span>
  );
}
