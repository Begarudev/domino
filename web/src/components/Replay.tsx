import { useEffect, useRef, useState } from 'react';
import type { ReplayOutcome, ReplayScore, RunSnapshot } from '../../../shared/types.ts';
import { addDays, daysBetween, fmtDate } from '../dates.ts';

const WHO: Record<ReplayOutcome['predictedBy'], string> = {
  domino: 'DOMINO', baseline_first_order: 'Hiring filter', baseline_headcount: 'Headcount +30%', both: 'DOMINO and hiring filter',
};

export function ReplayTab(props: { snap: RunSnapshot; outcomes: ReplayOutcome[]; reducedMotion: boolean; onRunReplay: () => void }) {
  const score = props.snap.replay;
  if (!score) {
    const isReplay = props.snap.intent?.runKind === 'replay';
    return (
      <div className="tab-empty">
        <p className="empty">{isReplay ? 'Scoring starts after the prediction is frozen. Outcomes appear here as they are checked.' : 'Replay freezes the world at a past date, predicts with only the facts known then, and scores what actually happened next.'}</p>
        {!isReplay && <button type="button" className="btn btn-quiet btn-sm" onClick={props.onRunReplay}>Run the replay example</button>}
      </div>
    );
  }
  return <Scoreboard score={score} snap={props.snap} reducedMotion={props.reducedMotion} />;
}

function Scoreboard({ score, snap, reducedMotion }: { score: ReplayScore; snap: RunSnapshot; reducedMotion: boolean }) {
  const total = Math.max(1, daysBetween(score.asOf, score.horizonEnd));
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const now = addDays(score.asOf, day);
  const name = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? id;

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const play = () => {
    if (reducedMotion) { setDay(total); return; }
    setPlaying(true);
    const t0 = performance.now();
    const dur = 6500;
    const tick = (t: number) => {
      const f = Math.min(1, (t - t0) / dur);
      setDay(Math.round(f * total));
      if (f < 1) raf.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const done = day >= total;
  const state = (o: ReplayOutcome) => (o.hit && o.outcomeDate && o.outcomeDate <= now ? 'hit' : done ? 'miss' : 'open');
  const ordered = [...score.outcomes].sort((a, b) => order(a.predictedBy) - order(b.predictedBy));
  const counted = (who: ReplayOutcome['predictedBy'][]) => {
    const rows = score.outcomes.filter((o) => who.includes(o.predictedBy));
    return rows.filter((o) => state(o) === 'hit').length;
  };

  return (
    <div className="replay">
      <div className="replay-clock">
        <p className="replay-asof">As of</p>
        <p className="replay-date num">{fmtDate(now, { year: true })}</p>
        <p className="replay-guard">Facts after {fmtDate(score.asOf)} used: <b className={score.factsAfterAsOfUsed === 0 ? 'ok' : 'miss'}>{score.factsAfterAsOfUsed}</b></p>
        <button type="button" className="btn btn-primary btn-sm" onClick={play} disabled={playing}>{done ? `Play to ${fmtDate(score.horizonEnd)} again` : `Play to ${fmtDate(score.horizonEnd)}`}</button>
        <div className="scrub" aria-hidden="true">
          <span className="scrub-fill" style={{ width: `${(day / total) * 100}%` }} />
          {score.outcomes.filter((o) => o.outcomeDate).map((o, i) => (
            <span key={i} className={`scrub-tick${o.outcomeDate! <= now ? ' is-past' : ''}`} style={{ left: `${(daysBetween(score.asOf, o.outcomeDate!) / total) * 100}%` }} />
          ))}
        </div>
        <input
          type="range" className="scrub-input" min={0} max={total} value={day} aria-label="Replay date"
          onChange={(e) => setDay(+e.target.value)}
        />
      </div>

      <ul className="outcomes">
        {ordered.map((o, i) => (
          <li key={i} className={`outcome is-${state(o)}`}>
            <span className="outcome-who">{WHO[o.predictedBy]}</span>
            <span className="outcome-co">{name(o.companyId)}</span>
            <span className="outcome-what">{state(o) === 'open' ? 'waiting' : o.outcome}</span>
          </li>
        ))}
      </ul>

      <div className="board">
        <table>
          <thead>
            <tr><th scope="col">Method</th><th scope="col">Picked</th><th scope="col">Hits so far</th><th scope="col">Precision</th><th scope="col">Median lead</th></tr>
          </thead>
          <tbody>
            <Row label="DOMINO" s={score.domino} live={counted(['domino', 'both'])} done={done} strong />
            <Row label="First-order hiring filter" s={score.baselineFirstOrder} live={counted(['baseline_first_order', 'both'])} done={done} />
            <Row label="Headcount +30% filter" s={score.baselineHeadcount} live={counted(['baseline_headcount'])} done={done} />
          </tbody>
        </table>
        <p className="board-note">{score.note}</p>
      </div>
    </div>
  );
}

function Row({ label, s, live, done, strong }: { label: string; s: ReplayScore['domino']; live: number; done: boolean; strong?: boolean }) {
  return (
    <tr className={strong ? 'is-strong' : ''}>
      <th scope="row">{label}</th>
      <td className="num">{s.predicted}</td>
      <td className="num">{done ? s.hits : live}</td>
      <td className="num">{done ? `${Math.round(s.precision * 100)}%` : ''}</td>
      <td className="num">{done ? (s.medianLeadDays == null ? 'none' : `${s.medianLeadDays} days`) : ''}</td>
    </tr>
  );
}

const order = (p: ReplayOutcome['predictedBy']) => ({ domino: 0, both: 1, baseline_first_order: 2, baseline_headcount: 3 })[p];
