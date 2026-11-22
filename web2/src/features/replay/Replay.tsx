// FEATURE 7: replay scorecard. O1 frozen at the replay date, scored against dated job posts and hires up to the
// horizon. The result is earned: a scrubber plays the window and the summary appears only at the end. Raw counts only.
// Data: desk.replay (GET /api/companies/:id) or the page run's snapshot.replay. No replay -> an honest empty state.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayScore } from '../../../../shared/types.ts';
import type { CompanyDesk } from '../../data/desk.ts';
import { useRunSel } from '../../data/store.ts';
import { fmtDate, fmtInt, plural } from '../../lib/format.ts';
import { reducedMotion } from '../../lib/motion.ts';
import './replay.css';

type Score = ReplayScore & { cohort?: number; lockedAt?: string };
const DAY = 86_400_000;
const PLAY_MS = 4200;
const t = (iso: string) => Date.parse(iso.length === 7 ? `${iso}-01` : iso);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function useLockedAt(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/openings/funnel').then((r) => (r.ok ? r.json() : null)).then((f) => { if (live && f?.lockedAt) setV(String(f.lockedAt)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return v;
}
/** "22 Nov 2026 14:08 IST (…), before replay outcomes" -> "14:08 IST on 22 Nov" */
const lockTime = (s: string | null) => { const m = s?.match(/(\d{1,2} \w{3})(?: \d{4})? (\d{1,2}:\d{2} IST)/); return m ? `${m[2]} on ${m[1]}` : null; };

export function Replay({ desk }: { desk: CompanyDesk }) {
  const runReplay = useRunSel((v) => v.ui.snap?.replay ?? null);
  const score = (desk.replay ?? runReplay) as Score | null;
  const locked = lockTime(useLockedAt());
  if (!score) return <ReplayEmpty locked={locked} />;
  return <ReplayCard score={score} locked={locked} />;
}

function ReplayEmpty({ locked }: { locked: string | null }) {
  return (
    <div className="replay">
      <section className="panel rp-empty" data-testid="replay-empty">
        <header><h2>Awaiting a scored replay</h2><span className="st plain">O1 · not replayed</span></header>
        <div className="pad">
          <p>A replay freezes the data at 1 Sep, runs rule O1 as it was locked{locked ? ` at ${locked}` : ''}, then checks each company for a dated job post or hire in the role family afterwards. Until a replay run is scored, there are no counts to show.</p>
          <h3 className="rp-sub">What the scorecard will show</h3>
          <p className="rp-subline">Raw counts per selector once a replay is scored. Cells stay empty until then; nothing here is estimated.</p>
          <table className="t rp-table rp-ghost-t" aria-label="Scorecard columns, not yet scored">
            <thead><tr><th>Selector</th><th className="num">Companies selected</th><th className="num">Had the outcome</th><th className="num">Median lead</th></tr></thead>
            <tbody>
              {['O1 (locked rule)', 'Job-post baseline', 'Whole cohort (base rate)'].map((l) => (
                <tr key={l}><td>{l}</td><td className="num"><span className="faint">not scored</span></td><td className="num"><span className="faint">not scored</span></td><td className="num"><span className="faint">not scored</span></td></tr>
              ))}
            </tbody>
          </table>
          <p className="rp-subline">Integrity check: facts dated after 1 Sep used by O1 must be 0.</p>
        </div>
      </section>
    </div>
  );
}

function ReplayCard({ score, locked }: { score: Score; locked: string | null }) {
  const start = t(score.asOf);
  const end = t(score.horizonEnd);
  const span = Math.max(DAY, end - start);
  const events = useMemo(() => score.outcomes.filter((o) => o.hit && o.outcomeDate).map((o) => ({ ...o, at: t(o.outcomeDate!) })).sort((a, b) => a.at - b.at), [score]);
  const [pos, setPos] = useState(0); // 0..1
  const [playing, setPlaying] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const raf = useRef(0);
  const done = pos >= 1;
  const cursor = start + pos * span;
  const seen = events.filter((e) => e.at <= cursor);

  const play = () => {
    if (reducedMotion()) { setPos(1); return; }
    cancelAnimationFrame(raf.current);
    const from = pos >= 1 ? 0 : pos;
    const t0 = performance.now() - from * PLAY_MS;
    setPlaying(true);
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / PLAY_MS);
      setPos(p);
      if (p < 1) raf.current = requestAnimationFrame(tick); else setPlaying(false);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const pause = () => { cancelAnimationFrame(raf.current); setPlaying(false); };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const N = score.cohort ?? score.outcomes.length;
  const d = score.domino, base = score.baselineFirstOrder;
  const cohortHits = score.outcomes.filter((o) => o.hit).length;
  const ticks = monthTicks(start, end);

  return (
    <div className="replay">
      <section className="panel">
        <header>
          <h2>{fmtDate(score.asOf, true)} replay · outcomes through {fmtDate(score.horizonEnd, true)}</h2>
          <span className={`st ${score.factsAfterAsOfUsed === 0 ? 'verified' : 'held'}`}>O1 inputs · {fmtInt(score.factsAfterAsOfUsed)} facts dated after {fmtDate(score.asOf)}</span>
        </header>
        {score.snapshotLabel && <p className="rp-src">Snapshot: {score.snapshotLabel}</p>}
        <div className="pad rp-play">
          <button className="btn pri" data-testid="replay-play" onClick={playing ? pause : play}>{playing ? 'Pause' : done ? 'Play again' : pos > 0 ? 'Resume' : 'Play the replay'}</button>
          <div className="rp-track-wrap">
            <div className="rp-track" aria-hidden="true">
              <i className="rp-fill" style={{ transform: `scaleX(${pos})` }} /><i className="rp-head" style={{ left: `${pos * 100}%` }} />
              {events.filter((e) => e.at <= cursor).map((e, i) => (
                <span key={`${e.companyId}-${i}`} className="rp-ev on" style={{ left: `${((e.at - start) / span) * 100}%` }} title={`${fmtDate(e.outcomeDate)} · ${e.outcome}`} />
              ))}
            </div>
            <input className="rp-range" type="range" min={0} max={1000} value={Math.round(pos * 1000)} data-testid="replay-scrubber"
              aria-label="Replay date" aria-valuetext={fmtDate(iso(cursor), true)}
              onChange={(e) => { pause(); setPos(Number(e.target.value) / 1000); }} />
            <div className="rp-ticks">{ticks.map((m) => <span key={m.label} style={{ left: `${((m.at - start) / span) * 100}%` }}>{m.label}</span>)}</div>
          </div>
          <div className="rp-now">
            <b>{fmtDate(iso(cursor), true)}</b>
            <span>{plural(seen.length, 'company', 'companies')} with a dated post or hire so far</span>
          </div>
        </div>
      </section>

      {done ? (
        <section className="panel rp-summary" data-testid="replay-summary">
          <header><h2>Scorecard</h2><button className="btn sm" onClick={() => setDrawer((v) => !v)} aria-expanded={drawer} data-testid="replay-drawer">{drawer ? 'Hide protocol' : 'Show protocol and cohorts'}</button></header>
          <div className="pad">
            <p className="rp-lead">O1 selected <b>{fmtInt(d.predicted)}</b> of {fmtInt(N)} companies. {d.predicted === 0 ? 'Precision unavailable.' : `${fmtInt(d.hits)} had the tracked outcome.`}</p>
            <table className="t rp-table">
              <thead><tr><th>Selector</th><th className="num">Companies selected</th><th className="num">Had the outcome</th><th className="num">Median lead</th></tr></thead>
              <tbody>
                <tr><td><b>O1</b> (locked rule)</td><td className="num">{fmtInt(d.predicted)}</td><td className="num">{d.predicted ? `${fmtInt(d.hits)} of ${fmtInt(d.predicted)}` : <span className="faint">–</span>}</td><td className="num">{d.medianLeadDays != null ? `${fmtInt(d.medianLeadDays)} days` : <span className="faint">–</span>}</td></tr>
                <tr><td>Job-post baseline</td><td className="num">{fmtInt(base.predicted)}</td><td className="num">{fmtInt(base.hits)} of {fmtInt(base.predicted)}</td><td className="num">{base.medianLeadDays != null ? `${fmtInt(base.medianLeadDays)} days` : <span className="faint">–</span>}</td></tr>
                <tr><td>Whole cohort (base rate)</td><td className="num">{fmtInt(N)}</td><td className="num">{fmtInt(cohortHits)} of {fmtInt(N)}</td><td className="num"><span className="faint">–</span></td></tr>
              </tbody>
            </table>
            <p className="rp-why">{score.note}</p>
            <p className="rp-lock">O1 was locked{locked ? ` at ${locked}` : ''}, before scoring.</p>
          </div>
          {drawer && (
            <dl className="rp-drawer" data-testid="replay-protocol">
              <dt>Rule</dt><dd>O1: 2+ conclusive dated departures in one role family within 90 days, no dated replacement post or hire within 30 days</dd>
              <dt>Locked</dt><dd>{locked ?? 'lock time not reported by the server'}</dd>
              <dt>Snapshot</dt><dd>{score.snapshotLabel ?? 'not reported'}</dd>
              <dt>Outcome</dt><dd>{score.outcomeDefinition ?? 'not reported'}</dd>
              <dt>Cohorts</dt><dd>
                <ul className="rp-cohort"><li className="rp-cohort-h" aria-hidden="true"><span>Company</span><span>Selected by</span><span>Outcome</span><span>Date</span></li>{score.outcomes.map((o, i) => (
                  <li key={`${o.companyId}-${i}`}><span className="mono">{o.companyId}</span><span className="faint">{o.predictedBy === 'domino' ? 'O1' : o.predictedBy === 'both' ? 'O1 + baseline' : 'baseline'}</span>
                    <span>{o.hit ? <span className="tick">✓</span> : null} {o.outcome}</span><span className="rp-date faint">{o.outcomeDate ? fmtDate(o.outcomeDate, true) : 'undated'}</span></li>
                ))}</ul>
              </dd>
            </dl>
          )}
        </section>
      ) : (
        <section className="panel rp-held" aria-live="polite">
          <header><h2>Scorecard</h2><span className="faint">Counts appear when the replay reaches {fmtDate(score.horizonEnd, true)}</span></header>
          <div className="pad">
            <table className="t rp-table rp-ghost-t" aria-label="Scorecard, withheld until the end">
              <thead><tr><th>Selector</th><th className="num">Companies selected</th><th className="num">Had the outcome</th><th className="num">Median lead</th></tr></thead>
              <tbody>
                {['O1 (locked rule)', 'Job-post baseline', 'Whole cohort (base rate)'].map((l) => (
                  <tr key={l}><td>{l}</td><td className="num"><i className="ghost-bar" /></td><td className="num"><i className="ghost-bar" /></td><td className="num"><i className="ghost-bar" /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function monthTicks(start: number, end: number) {
  const out: { at: number; label: string }[] = [{ at: start, label: fmtDate(iso(start)) }];
  const d = new Date(start);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() < end - 6 * DAY) { out.push({ at: d.getTime(), label: fmtDate(iso(d.getTime())) }); d.setUTCMonth(d.getUTCMonth() + 1); }
  out.push({ at: end, label: fmtDate(iso(end)) });
  return out;
}
