// FEATURE 7: replay scorecard. If DOMINO had run on the replay date using only facts dated on or before it, what would
// rule O1 have predicted, and what actually happened by the horizon, against simple baselines? Every count shows at
// once; the timeline scrubber only filters the outcome list. Raw counts only.
// Data: desk.replay (GET /api/companies/:id) or the page run's snapshot.replay. No replay -> an honest empty state.
import { useEffect, useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { motion } from 'motion/react';
import type { ReplayScore } from '../../../../shared/types.ts';
import type { CompanyDesk } from '../../data/desk.ts';
import { useRunSel } from '../../data/store.ts';
import { fmtDate, fmtInt, plural } from '../../lib/format.ts';
import './replay.css';

type Score = ReplayScore & { cohort?: number; lockedAt?: string };
const DAY = 86_400_000;
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
          <p className="rp-subline">O1 reads only moves, posts and hires dated on or before 1 Sep. Size band and industry use today’s company profile.</p>
        </div>
      </section>
    </div>
  );
}

const BY: Record<ReplayScore['outcomes'][number]['predictedBy'], string> = {
  domino: 'O1', both: 'O1 + job-post', baseline_first_order: 'Job-post baseline', baseline_headcount: 'Headcount baseline',
};

function How({ children }: { children: React.ReactNode }) {
  return (
    <details className="rp-how"><summary>How this is computed</summary><div className="rp-how-b">{children}</div></details>
  );
}

function ReplayCard({ score, locked }: { score: Score; locked: string | null }) {
  const start = t(score.asOf);
  const end = t(score.horizonEnd);
  const span = Math.max(DAY, end - start);
  const events = useMemo(() => score.outcomes.filter((o) => o.hit && o.outcomeDate)
    .map((o) => ({ ...o, at: t(o.outcomeDate!) })).sort((a, b) => a.at - b.at), [score]);
  const [cut, setCut] = useState(1000); // scrubber 0..1000, default: whole window, all results visible
  const [focus, setFocus] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'hit' | 'miss'>('all');
  const cursor = start + (cut / 1000) * span;

  const noteRate = score.note?.match(/Base rate:\s*([\d,]+)\s+of\s+([\d,]+)/i);
  const num = (s: string) => Number(s.replace(/,/g, ''));
  const N = score.cohort ?? (noteRate ? num(noteRate[2]) : score.outcomes.length);
  const cohortHits = noteRate && score.cohort == null ? num(noteRate[1]) : score.outcomes.filter((o) => o.hit).length;
  const d = score.domino, base = score.baselineFirstOrder, hc = score.baselineHeadcount;

  const rows = score.outcomes
    .map((o, i) => ({ ...o, key: `${o.companyId}-${i}`, at: o.outcomeDate ? t(o.outcomeDate) : null }))
    .filter((o) => (only === 'all' ? true : only === 'hit' ? o.hit : !o.hit))
    .filter((o) => !q || `${o.companyId} ${o.outcome} ${BY[o.predictedBy]}`.toLowerCase().includes(q.toLowerCase()))
    .filter((o) => cut >= 1000 || (o.at != null && o.at <= cursor));
  const seen = events.filter((e) => e.at <= cursor).length;

  const series = [
    { name: 'Companies picked', data: [d.predicted, base.predicted, hc.predicted, N] },
    { name: 'Had the outcome by ' + fmtDate(score.horizonEnd), data: [d.hits, base.hits, hc.hits, cohortHits] },
  ];
  const cats = ['O1 (locked rule)', 'Job-post baseline', 'Headcount +30%', 'Whole cohort (base rate)'];
  const ticks = monthTicks(start, end);

  return (
    <div className="replay">
      <motion.section className="panel rp-hero" data-testid="replay-summary" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        <header>
          <h2>{fmtDate(score.asOf, true)} replay · outcomes through {fmtDate(score.horizonEnd, true)}</h2>
          <span className="ctag tone-not-evaluated">Moves, posts and hires dated on or before {fmtDate(score.asOf)} · size band and industry use today’s company profile</span>
        </header>
        <p className="rp-q pad">If DOMINO had run on {fmtDate(score.asOf, true)} using only facts dated on or before then, which companies would rule O1 have picked, and which actually posted or hired in the role family by {fmtDate(score.horizonEnd, true)}, compared with simple baselines?</p>
        <div className="rp-kpis">
          <Kpi big={fmtInt(d.predicted)} label="O1 picks" sub={d.predicted ? `${fmtInt(d.hits)} had the outcome` : 'no company met O1 at this cutoff'} />
          <Kpi big={`${fmtInt(base.hits)} / ${fmtInt(base.predicted)}`} label="Job-post baseline" sub="hits / picks · any post in last 30 days" />
          <Kpi big={`${fmtInt(hc.hits)} / ${fmtInt(hc.predicted)}`} label="Headcount baseline" sub="hits / picks · headcount +30%" />
          <Kpi big={`${fmtInt(cohortHits)} of ${fmtInt(N)}`} label="Base rate" sub="whole cohort with the outcome" />
        </div>
        <p className="rp-why pad">{score.note}</p>
        <div className="pad"><How>
          <p>Reads <code>GET /api/companies/:id</code> (field <code>replay</code>), written by the run’s replay step (<code>replay.scored</code> event).</p>
          <p><b>Rule O1</b>: 2+ conclusive dated departures in one role family within 90 days, no dated replacement post or hire within 30 days. Locked{locked ? ` at ${locked}` : ''}, before outcomes were looked at.</p>
          <p><b>Outcome</b>: {score.outcomeDefinition ?? 'a dated job post or hire in the role family after the cutoff'}.</p>
          <p><b>Data</b>: Crustdata person search and job search (cached), filtered to facts dated on or before {fmtDate(score.asOf, true)}. {score.snapshotLabel}</p>
        </How></div>
      </motion.section>

      <section className="panel">
        <header><h2>Selectors compared</h2><span className="faint">picks vs companies that had the outcome</span></header>
        <div className="pad rp-chart">
          <Chart type="bar" height={260} series={series} options={{
            chart: { toolbar: { show: false }, fontFamily: 'inherit', animations: { enabled: true, speed: 400 } },
            plotOptions: { bar: { horizontal: true, barHeight: '70%', borderRadius: 3 } },
            colors: ['#c9ced6', '#0f766e'], dataLabels: { enabled: true, style: { colors: ['#1f2328'] } },
            xaxis: { categories: cats }, grid: { borderColor: '#eceef1' }, legend: { position: 'top', horizontalAlign: 'left' },
            tooltip: { y: { formatter: (v: number) => plural(v, 'company', 'companies') } },
          }} />
        </div>
      </section>

      <section className="panel">
        <header><h2>Outcome timeline</h2><span className="faint">{plural(seen, 'dated outcome', 'dated outcomes')} by {fmtDate(iso(cursor), true)}</span></header>
        <div className="pad">
          <div className="rp-track-wrap">
            <div className="rp-track"><i className="rp-fill" style={{ transform: `scaleX(${cut / 1000})` }} /></div>
            {events.map((e) => (
              <button key={`${e.companyId}-${e.at}`} type="button" className={`rp-ev ${e.at <= cursor ? 'on' : ''} ${focus === e.companyId ? 'sel' : ''}`}
                style={{ left: `${((e.at - start) / span) * 100}%` }} title={`${e.companyId} · ${fmtDate(e.outcomeDate, true)} · ${e.outcome}`}
                aria-label={`${e.companyId}, ${fmtDate(e.outcomeDate, true)}: ${e.outcome}`}
                onClick={() => { setFocus(e.companyId); setCut(Math.round(((e.at - start) / span) * 1000)); }} />
            ))}
            <input className="rp-range" type="range" min={0} max={1000} value={cut} data-testid="replay-scrubber"
              aria-label="Show outcomes up to" aria-valuetext={fmtDate(iso(cursor), true)} onChange={(e) => setCut(Number(e.target.value))} />
            <div className="rp-ticks">{ticks.map((m) => <span key={m.label} style={{ left: `${((m.at - start) / span) * 100}%` }}>{m.label}</span>)}</div>
          </div>
          <div className="rp-tl-foot">
            <button className="btn sm" data-testid="replay-play" onClick={() => { setCut(1000); setFocus(null); }} disabled={cut >= 1000}>Show whole window</button>
            <span className="faint">Drag the scrubber or click a marker: the table below shows outcomes dated up to that day.</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Per-company outcomes</h2>
          <div className="rp-toolbar">
            <input className="rp-search" placeholder="Search company or outcome" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search outcomes" />
            {(['all', 'hit', 'miss'] as const).map((k) => (
              <button key={k} className={`rp-chip ${only === k ? 'on' : ''}`} onClick={() => setOnly(k)}>{k === 'all' ? 'All' : k === 'hit' ? 'Had outcome' : 'No sign yet'}</button>
            ))}
            <span className="faint" data-testid="replay-drawer">{plural(rows.length, 'row', 'rows')}</span>
          </div>
        </header>
        <table className="t rp-table" data-testid="replay-protocol">
          <thead><tr><th>Company</th><th>Picked by</th><th>Outcome</th><th className="num">Date</th></tr></thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.key} className={focus === o.companyId ? 'sel' : ''} onClick={() => setFocus(o.companyId)}>
                <td className="mono">{o.companyId}</td>
                <td><span className={`rp-by by-${o.predictedBy}`}><i />{BY[o.predictedBy]}</span></td>
                <td>{o.hit ? <span className="tick">✓ </span> : null}{o.outcome}</td>
                <td className="num faint">{o.outcomeDate ? fmtDate(o.outcomeDate, true) : 'undated'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="faint">No outcome rows match this search, filter or date. Widen the scrubber to {fmtDate(score.horizonEnd, true)}.</td></tr>}
          </tbody>
        </table>
        <div className="pad"><How>
          <p>Rows come from <code>replay.outcomes</code>: every company some selector picked. An outcome is a dated job post or hire in the role family after {fmtDate(score.asOf, true)}; its evidence ids are kept on the row. "No sign yet" means none was found up to {fmtDate(score.horizonEnd, true)}.</p>
        </How></div>
      </section>
    </div>
  );
}

function Kpi({ big, label, sub }: { big: string; label: string; sub: string }) {
  return <div className="rp-kpi"><b>{big}</b><span>{label}</span><small>{sub}</small></div>;
}

function monthTicks(start: number, end: number) {
  const out: { at: number; label: string }[] = [{ at: start, label: fmtDate(iso(start)) }];
  const d = new Date(start);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() < end - 6 * DAY) { out.push({ at: d.getTime(), label: fmtDate(iso(d.getTime())) }); d.setUTCMonth(d.getUTCMonth() + 1); }
  out.push({ at: end, label: fmtDate(iso(end)) });
  return out;
}
