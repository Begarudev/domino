// The O1 funnel for today's scan: every count opens its rows (role, initial, month). Shown only with real funnel
// data from GET /api/openings/funnel; a missing endpoint hides the strip (there is no fixture funnel).
import { useState } from 'react';
import Chart from 'react-apexcharts';
import type { FunnelStage, OpeningsFunnel } from '../../../../shared/desk.ts';
import type { Sourced } from '../../data/desk.ts';
import { useQuery } from '../../data/query.ts';
import { runStore } from '../../data/store.ts';
import { fmtInt } from '../../lib/format.ts';
import { openEvidence } from '../../shell/ui.ts';
import { prettyDates } from './derive.ts';
import { HowComputed } from './Openings.tsx';

async function loadFunnel(): Promise<Sourced<OpeningsFunnel | null>> {
  const none = { data: null, source: 'live' as const, evidence: [] };
  try {
    const res = await fetch('/api/openings/funnel');
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return none;
    const data = await res.json() as OpeningsFunnel;
    return Array.isArray(data?.stages) && data.stages.length ? { ...none, data } : none;
  } catch {
    return none;
  }
}

// Short names for the strip; the stage's own label is the drill-down heading and the hover text.
const SHORT: Record<string, string> = {
  profiles: 'job moves read', departures: 'left a tracked role family', window: 'dated inside the 90 days',
  icp: 'at a 20–5,000 staff company', groups: 'company and family with 2 or more',
};
const OUTCOMES = ['open', 'provisional', 'held', 'watch'];
const OUTCOME_WORD: Record<string, string> = { open: 'settled', provisional: 'provisional', held: 'held', watch: 'watch' };
const SHOW = 40;

/** "22 Nov 2026 14:08 IST (…), before replay outcomes" -> "pre-registered 22 Nov, 14:08 IST" */
function lockText(lockedAt: string): string {
  const m = lockedAt.match(/^(\d{1,2} [A-Z][a-z]{2})(?: \d{4})?,? (\d{1,2}:\d{2} IST)/);
  return m ? `pre-registered ${m[1]}, ${m[2]}` : `pre-registered ${lockedAt}`;
}

export function FunnelStrip({ runId }: { runId: string | null }) {
  const live = runStore.get().mode === 'live';
  const q = useQuery(live ? 'openings-funnel' : null, loadFunnel);
  const [open, setOpen] = useState<string | null>(null);
  const f = q.data;
  if (!f) return null;
  const steps = f.stages.filter((s) => !OUTCOMES.includes(s.id));
  const outcomes = OUTCOMES.map((id) => f.stages.find((s) => s.id === id)).filter((s): s is FunnelStage => !!s);
  const top = Math.max(1, steps[0]?.count ?? 1);
  const sel = f.stages.find((s) => s.id === open) ?? null;
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  const shown = outcomes.filter((s) => s.count > 0);
  const quiet = outcomes.filter((s) => s.count === 0);

  // A vertical funnel under the departures it explains: each count is a row that opens its records.
  return (
    <div className="panel rec-funnel" data-testid="funnel">
      <header>
        <h2>How today’s scan got here</h2>
        <span className="faint" title={f.lockedAt}>O1 · {lockText(f.lockedAt)}</span>
        <HowComputed><b>GET /api/openings/funnel</b>: the counts today's O1 scan kept at each step. Job moves read from Crustdata person search, filtered to a tracked role family, to a leave date inside the 90-day window, to a 20–5,000 staff company (Crustdata company enrich), then grouped by company and family; groups with 2 or more become O1 decisions. Click a step to list its rows.</HowComputed>
      </header>
      <div className="rec-apex" data-testid="funnel-chart">
        <Chart type="bar" height={Math.max(150, steps.length * 40)} series={[{ name: 'Rows kept', data: steps.map((s) => s.count) }]}
          options={{
            chart: { toolbar: { show: false }, fontFamily: 'inherit', animations: { enabled: true, speed: 450, animateGradually: { enabled: true, delay: 60 }, dynamicAnimation: { enabled: false } },
              events: { dataPointSelection: (_e, _c, cfg) => { const s = steps[cfg?.dataPointIndex ?? -1]; if (s) toggle(s.id); } } },
            plotOptions: { bar: { horizontal: true, borderRadius: 3, barHeight: '62%', distributed: true } },
            colors: steps.map((s) => (open === s.id ? '#2e6be6' : '#12a594')),
            legend: { show: false }, grid: { borderColor: '#ebecef', strokeDashArray: 3, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
            dataLabels: { enabled: true, formatter: (v: number) => fmtInt(v), style: { fontSize: '12px', fontWeight: 600, colors: ['#ffffff'] } },
            xaxis: { categories: steps.map((s) => SHORT[s.id] ?? s.label), labels: { style: { colors: '#8a8f98', fontSize: '11px' } } },
            yaxis: { labels: { maxWidth: 220, style: { colors: '#4b5059', fontSize: '12px' } } },
            tooltip: { y: { formatter: (v: number) => `${fmtInt(v)} · ${Math.round((v / top) * 1000) / 10}% of job moves read · click to list rows` } },
            states: { active: { filter: { type: 'none' } } },
          }} />
      </div>
      <ol className="rec-fun">
        {steps.map((s) => (
          <li key={s.id}>
            <button type="button" className={open === s.id ? 'on' : undefined} onClick={() => toggle(s.id)}
              aria-expanded={open === s.id} title={`${s.label}: ${fmtInt(s.count)} (${Math.round((s.count / top) * 1000) / 10}% of job moves read)`} data-testid={`funnel-stage-${s.id}`}>
              <b data-num>{fmtInt(s.count)}</b>
              <span className="rec-fun-l">{SHORT[s.id] ?? s.label}</span>
              <span className="rec-fun-bar"><i style={{ width: `${Math.max(0.6, (s.count / top) * 100)}%` }} /></span>
            </button>
          </li>
        ))}
        <li className="rec-fun-out">
          {shown.map((s, i) => (
            <span key={s.id} className="rec-fun-o">
              {i > 0 && <span className="rec-plus" aria-hidden>+</span>}
              <button type="button" className={open === s.id ? 'on' : undefined} onClick={() => toggle(s.id)} aria-expanded={open === s.id}
                title={`${s.label}: ${fmtInt(s.count)} (${Math.round((s.count / top) * 1000) / 10}% of job moves read)`} data-testid={`funnel-stage-${s.id}`}>
                <b data-num>{fmtInt(s.count)}</b><span>{OUTCOME_WORD[s.id]}</span>
              </button>
            </span>
          ))}
          {!shown.length && <span className="muted">no decision today</span>}
          {quiet.length > 0 && (
            <span className="rec-fun-quiet">
              {quiet.map((s, i) => (
                <span key={s.id}>{i > 0 && ' · '}<button type="button" className="srclink" onClick={() => toggle(s.id)} data-testid={`funnel-stage-${s.id}`} title={s.label}>{fmtInt(s.count)} {OUTCOME_WORD[s.id]}</button></span>
              ))}
            </span>
          )}
        </li>
      </ol>
      <div className={`rec-x ${sel ? 'on' : ''}`} aria-hidden={!sel}>
        <div className="rec-x-in">{sel && <StageRows stage={sel} snapshot={f.snapshot} runId={f.runId} deskRunId={runId} />}</div>
      </div>
    </div>
  );
}

function StageRows({ stage, snapshot, runId, deskRunId }: { stage: FunnelStage; snapshot: string; runId: string; deskRunId: string | null }) {
  const rows = stage.rows ?? [];
  const [all, setAll] = useState(false);
  const list = all ? rows : rows.slice(0, SHOW);
  return (
    <div className="rec-stage" data-testid={`funnel-rows-${stage.id}`}>
      <div className="rec-stage-h">
        <b>{fmtInt(stage.count)} · {stage.label}</b>
        <span className="faint">{prettyDates(snapshot)}{deskRunId && deskRunId !== runId ? ` · run ${runId.slice(0, 12)}` : ''}</span>
      </div>
      {!rows.length ? (
        <p className="faint rec-stage-empty">
          {stage.count === 0 ? 'No row reached this stage today.' : 'The scan kept only the count for this stage. The rows it carried forward are in the next stage.'}
        </p>
      ) : (
        <table className="t rec-stage-t">
          {groupRows(stage, list).map((g) => (
            <tbody key={g.company ?? 'all'}>
              {g.company && (
                <tr className="rec-grp"><td><b>{g.company}</b> <span className="faint">· {g.rows.length === 1 ? '1 person' : `${fmtInt(g.rows.length)} people`}</span></td></tr>
              )}
              {g.rows.map((r, i) => (
                <tr key={`${r.evidenceId ?? ''}${i}`} className={r.evidenceId ? 'rec-click' : undefined} tabIndex={r.evidenceId ? 0 : undefined}
                  onClick={() => r.evidenceId && openEvidence(r.evidenceId)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && r.evidenceId) openEvidence(r.evidenceId); }}>
                  <td className={g.company ? 'rec-grp-row' : undefined}>
                    <span className={/not conclusive/.test(r.detail ?? '') ? 'struck' : undefined}>{g.company ? r.label.replace(` · ${g.company}`, '') : r.label}</span>
                    {r.detail && <div className="rec-stage-d muted">{r.detail}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
      {rows.length > SHOW && <button type="button" className="btn sm rec-more" onClick={() => setAll((v) => !v)}>{all ? `Show the first ${SHOW}` : `Show all ${fmtInt(rows.length)} rows`}</button>}
    </div>
  );
}

type Row = NonNullable<FunnelStage['rows']>[number];
/**
 * A stage that counts groups ("3 company and role family groups") but lists people: nest the people under their
 * company, read from the row label ("P. ML Platform Engineer · Abacus.AI · left Oct 2026 → …").
 */
function groupRows(stage: FunnelStage, rows: Row[]): { company: string | null; rows: Row[] }[] {
  const companyOf = (r: Row) => (r.label.includes(' · left ') ? r.label.split(' · left ')[0].split(' · ').at(-1) ?? null : null);
  if (stage.count >= rows.length || !rows.every(companyOf)) return [{ company: null, rows }];
  const out = new Map<string, Row[]>();
  for (const r of rows) { const c = companyOf(r)!; out.set(c, [...(out.get(c) ?? []), r]); }
  return [...out].map(([company, rs]) => ({ company, rows: rs }));
}
