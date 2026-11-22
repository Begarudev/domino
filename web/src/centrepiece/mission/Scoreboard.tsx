// Replay scoreboard: the clock is frozen at asOf, then runs to horizonEnd. Every prediction hangs on its shelf;
// when the clock reaches the dated event that proved it, the tile drops onto that date. Misses stay up.
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ReplayOutcome } from '../../../../shared/types.ts';
import type { Selection } from '../contract.ts';
import type { ReplayView } from './model.ts';
import { day, dayNumber, isoFromDay } from './model.ts';

const SWEEP_MS = 7600;

type LaneId = 'domino' | 'baseline_first_order' | 'baseline_headcount';
const LANES: { id: LaneId; name: string; blurb: string }[] = [
  { id: 'domino', name: 'DOMINO', blurb: 'cross-company rules' },
  { id: 'baseline_first_order', name: 'Hiring filter', blurb: 'posts infra roles itself' },
  { id: 'baseline_headcount', name: 'Headcount filter', blurb: 'grew 30% or more' },
];

function inLane(o: ReplayOutcome, lane: LaneId) {
  return o.predictedBy === lane || (o.predictedBy === 'both' && lane !== 'baseline_headcount');
}

export function Scoreboard({ view, animate, nameOf, onSelect, fixture, reducedMotion }: {
  view: ReplayView; animate: boolean; nameOf: (id: string) => string; onSelect: (s: Selection | null) => void;
  fixture: boolean; reducedMotion: boolean;
}) {
  const a = dayNumber(view.asOf);
  const b = dayNumber(view.horizonEnd);
  const span = Math.max(1, b - a);
  const [p, setP] = useState(animate && !reducedMotion ? 0 : 1);

  useEffect(() => {
    if (!animate || reducedMotion) { setP(1); return; }
    setP(0);
    let raf = 0;
    let last = -1;
    const t0 = performance.now() + 900; // hold on the frozen date for a beat
    const tick = (now: number) => {
      const q = Math.max(0, Math.min(1, (now - t0) / SWEEP_MS));
      const d = Math.floor(q * span);
      if (d !== last || q === 1) { last = d; setP(q); }
      if (q < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, reducedMotion, view.scoredSeq, span]);

  const clockDay = a + Math.floor(p * span);
  const done = p >= 1;
  const xOf = (iso: string) => ((dayNumber(iso) - a) / span) * 100;

  const ticks = useMemo(() => {
    const out: { x: number; label: string }[] = [];
    const start = new Date(view.asOf + 'T00:00:00Z');
    for (let m = 0; m < 4; m++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
      const iso = d.toISOString().slice(0, 10);
      if (dayNumber(iso) >= a && dayNumber(iso) <= b) out.push({ x: xOf(iso), label: day(iso) });
    }
    out.push({ x: 100, label: day(view.horizonEnd) });
    return out;
  }, [view.asOf, view.horizonEnd]);

  const lanes = LANES.map((lane) => {
    const items = view.outcomes.filter((o) => inLane(o, lane.id));
    const hitsSoFar = items.filter((o) => o.hit && o.outcomeDate && dayNumber(o.outcomeDate) <= clockDay).length;
    return { ...lane, items, hitsSoFar };
  }).filter((l) => l.items.length > 0);

  const final = view.score;
  const stats: Record<LaneId, { predicted: number; hits: number; medianLeadDays: number | null } | undefined> = {
    domino: final?.domino, baseline_first_order: final?.baselineFirstOrder, baseline_headcount: final?.baselineHeadcount,
  };

  return (
    <div className={`mc-score${done ? ' is-done' : ''}`}>
      <header className="mc-score__head">
        <div className="mc-score__clock">
          <span className="mc-score__k">{p === 0 ? 'Clock frozen at' : done ? 'Scored up to' : 'Replaying'}</span>
          <span className="mc-score__date">{day(isoFromDay(clockDay), true)}</span>
        </div>
        <div className="mc-score__guard">
          <span><b>0</b> facts dated after {day(view.asOf)} were used to predict</span>
          {final && final.factsAfterAsOfUsed !== 0 && <span className="mc-score__leak">Leak guard: {final.factsAfterAsOfUsed} later facts used</span>}
          {fixture && <span className="mc-score__fixture">Fixture replay: synthetic companies, not a real score</span>}
        </div>
      </header>

      <div className="mc-score__lanes" style={{ ['--p' as string]: p } as CSSProperties}>
        {lanes.map((lane) => {
          const s = stats[lane.id];
          const n = lane.items.length;
          return (
            <div key={lane.id} className={`mc-lane mc-lane--${lane.id}`}>
              <div className="mc-lane__tally">
                <span className="mc-lane__name">{lane.name}</span>
                <span className="mc-lane__blurb">{lane.blurb}</span>
                <span className="mc-lane__num"><b>{lane.hitsSoFar}</b><small>of {n}</small></span>
                <span className="mc-lane__sub">
                  {done && s ? `${Math.round((s.hits / Math.max(1, s.predicted)) * 100)}% right${s.medianLeadDays != null ? ` · median lead ${s.medianLeadDays} d` : ''}` : 'showed the need'}
                </span>
              </div>
              <div className="mc-lane__track">
                {lane.items.map((o, i) => {
                  const fell = o.hit && !!o.outcomeDate && dayNumber(o.outcomeDate) <= clockDay;
                  const shelfX = (i + 0.5) * Math.min(16, 100 / n);
                  const x = fell && o.outcomeDate ? xOf(o.outcomeDate) : shelfX;
                  const miss = done && !fell;
                  return (
                    <button
                      type="button"
                      key={`${o.companyId}-${i}`}
                      className={`mc-ptile${fell ? ' is-fallen' : ''}${miss ? ' is-miss' : ''}`}
                      style={{ ['--x' as string]: x } as CSSProperties}
                      onClick={() => onSelect(o.evidenceIds[0] ? { kind: 'evidence', id: o.evidenceIds[0] } : { kind: 'node', id: o.companyId })}
                    >
                      <span className="mc-ptile__face">{nameOf(o.companyId)}</span>
                      <span className="mc-ptile__what">{fell ? o.outcome : miss ? `No dated sign by ${day(view.horizonEnd)}` : 'Predicted'}</span>
                    </button>
                  );
                })}
                <div className="mc-lane__floor" />
              </div>
            </div>
          );
        })}
        <div className="mc-score__axis">
          {ticks.map((t) => <span key={t.label} style={{ left: `${t.x}%` }}>{t.label}</span>)}
        </div>
        <div className="mc-score__needle" aria-hidden="true" />
      </div>

      <footer className="mc-score__note">{done ? final?.note ?? '' : ' '}</footer>
    </div>
  );
}
