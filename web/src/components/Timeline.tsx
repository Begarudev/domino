import { useEffect, useRef } from 'react';
import type { RunSnapshot, StepState } from '../../../shared/types.ts';
import type { TimelineItem, UIState } from '../state.ts';

const fmtDur = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function StepMark({ s }: { s: StepState }) {
  return <span className={`mark mark-${s.status}${s.resumedFromCheckpoint ? ' mark-reused' : ''}`} aria-hidden="true" />;
}

/** Collapse runs of identical sub-events (e.g. six model timeouts in a row) into one line with a count. */
function grouped(items: TimelineItem[]) {
  const out: { it: TimelineItem; n: number }[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    const key = (x: TimelineItem) => `${x.tone}|${x.text.replace(/[\d.]+ (ms|s)\b/g, '#')}`;
    if (last && !it.rule && !last.it.rule && key(last.it) === key(it)) last.n += 1;
    else out.push({ it, n: 1 });
  }
  return out;
}

function Item({ it, n = 1 }: { it: TimelineItem; n?: number }) {
  if (it.rule) {
    return (
      <li className={`tl-rule tl-rule-${it.tone}`}>
        <span className="tl-rule-text">{it.text}</span>
        {it.detail && <span className="tl-detail">{it.detail}</span>}
      </li>
    );
  }
  return (
    <li className={`tl-item tl-${it.tone}`}>
      <span>{it.text}{n > 1 && <b className="tl-count"> ×{n}</b>}</span>
      {it.detail && <span className="tl-detail">{it.detail}</span>}
    </li>
  );
}

export function Timeline(props: { state: UIState; hasRun: boolean; onKill: () => void; onResume: () => void; busy: string | null }) {
  const { snap, timeline, durations } = props.state;
  const end = useRef<HTMLDivElement | null>(null);
  const live = snap.steps.filter((s) => !(s.step === 'score_replay' && snap.intent?.runKind === 'live' && s.status === 'pending'));
  const orphan = timeline.filter((t) => !t.step);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [timeline.length, snap.steps]);

  const canKill = snap.status === 'running' && snap.engine.alive !== false;
  const canResume = snap.status === 'crashed';

  return (
    <section className="panel timeline" aria-label="Run timeline">
      <header className="panel-head">
        <h2>Run</h2>
        <EngineLine snap={snap} />
      </header>
      <div className="panel-scroll">
        {!props.hasRun && <p className="empty">Steps, retries, merges and crashes appear here as the engine works.</p>}
        {props.hasRun && (
          <ol className="steps">
            {orphan.map((it) => <Item key={`${it.seq}-${it.text}`} it={it} />)}
            {live.map((s) => {
              const items = timeline.filter((t) => t.step === s.step);
              return (
                <li key={s.step} className={`step step-${s.status}`}>
                  <div className="step-row">
                    <StepMark s={s} />
                    <span className="step-label">{s.label}</span>
                    <span className="step-dur">{s.resumedFromCheckpoint ? 'reused' : fmtDur(durations[s.step])}</span>
                  </div>
                  {s.summary && s.status !== 'pending' && <p className="step-summary">{s.summary}</p>}
                  {s.attempt > 1 && s.status !== 'pending' && <p className="step-summary">Attempt {s.attempt}</p>}
                  {items.length > 0 && <ul className="tl-items">{grouped(items).map(({ it, n }, i) => <Item key={`${it.seq}-${i}`} it={it} n={n} />)}</ul>}
                </li>
              );
            })}
          </ol>
        )}
        <div ref={end} />
      </div>
      <footer className="panel-foot">
        {canResume ? (
          <button type="button" className="btn btn-primary btn-block" onClick={props.onResume} disabled={props.busy === 'resume'}>Resume from checkpoint</button>
        ) : (
          <button type="button" className="btn btn-danger btn-block" onClick={props.onKill} disabled={!canKill || props.busy === 'kill'} title="SIGKILL the engine process mid-step">Crash engine</button>
        )}
      </footer>
    </section>
  );
}

function EngineLine({ snap }: { snap: RunSnapshot }) {
  const e = snap.engine;
  if (!e.pid) return null;
  return (
    <span className="engine-line">
      pid <b>{e.pid}</b>{e.crashes ? `, ${e.crashes} crash${e.crashes > 1 ? 'es' : ''}` : ''}{e.resumes ? `, ${e.resumes} resume${e.resumes > 1 ? 's' : ''}` : ''}
    </span>
  );
}
