// Company file (mock screen 6): dated facts about one company and the four rules run on it. No generated prose:
// every row is a fact with its date and source, and every row with an evidence id opens it in the drawer.
// Data: GET /api/companies/:id/dossier. If that fails, the rows the company view already holds (departures, the O1
// opening, headcount) still show, and everything else says plainly that it isn't loaded. Nothing is invented.
import { useRef, useState } from 'react';
import type { CompanyDesk, CompanyDossier, Departure } from '../../data/desk.ts';
import { deskApi, useQuery } from '../../data/query.ts';
import type { Evidence } from '../../../../shared/types.ts';
import type { DossierEvent, DossierRule, RuleClause } from '../../../../shared/desk.ts';
import { daysBetween, fmtDate, fmtInt, plural } from '../../lib/format.ts';
import { openEvidence } from '../../shell/ui.ts';
import { sourceName } from '../../shell/EvidenceDrawer.tsx';
import './analysis.css';
import { DominoGraph } from '../network/DominoGraph.tsx';

type EvMap = Map<string, Evidence>;
const isMonth = (e: Evidence | undefined) => !!e && (e.precision === 'month' || /month precision/i.test(e.claim));
/** A dated fact at its real precision: month-level rows read "Oct 2026", never a made-up day. */
const when = (iso: string | null | undefined, month: boolean) => (iso ? fmtDate(month ? iso.slice(0, 7) : iso, true) : 'undated');
/** One decimal, signed, with a true minus: +3.6%, −13.2% (the same rounding the restructure clause uses). */
/** Server fact lines carry ISO dates ("on 2026-11-02"); show them like every other date ("2 Nov 2026"). */
const prettyDates = (t: string) => t.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => fmtDate(iso, true));
const hostOf = (e: Evidence) => (e.source.url ? e.source.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : null);
/** The decisive count in a search row ("0 records") is the fact the rule used; set it in the same weight as a value. */
function factLine(t: string) {
  const parts = prettyDates(t).split(/(\b\d[\d,]* records?\b)/);
  return parts.map((x, i) => (i % 2 ? <b key={i} className="cf-count">{x}</b> : x));
}
const pct1 = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.round(Math.abs(p) * 10) / 10).toFixed(1)}%`;

export function Analysis({ desk }: { desk: CompanyDesk }) {
  const q = useQuery<CompanyDossier>(`dossier:${desk.company.id}`, () => deskApi.dossier(desk.company.id));
  const [openRule, setOpenRule] = useState<string | null>(null);
  const lastRule = useRef<string | null>(null); // keeps the closing panel's content while it collapses
  if (!q.data && !q.error) return <div className="ghost-rows" aria-hidden data-testid="file-loading"><span /><span /><span /></div>;
  const d = q.data;
  const ev: EvMap = new Map((d?.evidence ?? desk.evidence ?? []).map((e) => [e.id, e]));
  const company = d?.company ?? desk.company;
  const meta = [company.domain, company.industry, company.hq].filter(Boolean) as string[];
  const rules: DossierRule[] = d?.rules ?? [o1FromDesk(desk)].filter((r): r is DossierRule => !!r);
  if (openRule) lastRule.current = openRule;
  const family = d?.predictedNeeds[0]?.need ?? null;
  // O1's departure clause says how many departures were conclusive; ranking counts every record in the window.
  const o1Conclusive = rules.find((r) => r.id === 'O1')?.clauses.find((c) => c.id === 'o1.departures')?.text.match(/^(\d+) conclusive/)?.[1] ?? null;
  const shown = rules.find((r) => r.id === (openRule ?? lastRule.current)) ?? null;

  return (
    <div className="cf" data-testid="company-file">
      <header className="cf-id">
        <div>
          <h2 className="cf-name">{company.name}</h2>
          <p className="cf-meta">
            {meta.map((m, i) => <span key={m}>{i > 0 && ' · '}{i === 0 ? <span className="mono">{m}</span> : m}</span>)}
            {meta.length > 0 && '. '}Every row has a date and a source.
          </p>
        </div>
        {d && (
          <p className="cf-run" title={d.runId}>
            <span>From the {d.source === 'analysis_run' ? 'company analysis run' : 'openings scan'} <span className="mono">{d.runId.slice(0, 12)}</span>{d.asOf && <>, as of {fmtDate(d.asOf, true)}</>}</span>
            {d.dataMode === 'fixture' && <span className="tag">fixture</span>}
          </p>
        )}
      </header>

      {q.error && (
        <div className="cf-err" role="alert" data-testid="file-error">
          <div>
            <b>Company file unavailable for {company.name}.</b>
            <span>The O1 decision and talent flows below are from the company view{desk.checkedAt ? ` (checked ${fmtDate(desk.checkedAt, true)})` : ''}. The dossier request said: {q.error.replace(/\.$/, '')}.</span>
          </div>
          <button className="btn small" onClick={q.refetch}>Try again</button>
        </div>
      )}

      <div className={`cf-top ${hasFunding(d) ? '' : 'no-fund'}`}>
        <Headcount d={d} desk={desk} />
        <Funding d={d} />
        <Rules rules={rules} fromDesk={!d} name={desk.company.name} open={openRule} onToggle={(id) => setOpenRule(openRule === id ? null : id)} family={family} ev={ev} />
      </div>

      <div className={`cf-x ${openRule && shown ? 'on' : ''}`}><div className="cf-x-in">
        {shown && <RuleDetail r={shown} ev={ev} onClose={() => setOpenRule(null)} />}
      </div></div>

      {d?.whyTarget && (
        <section className="panel cf-why" data-testid="file-why">
          <span className="cf-why-h">Why this target</span>
          <span className="cf-why-pos num">{d.whyTarget.companyRanking.position} of {fmtInt(d.whyTarget.companyRanking.of)} companies</span>
          <span className="cf-why-rule">{d.whyTarget.companyRanking.rule}</span>
          <span className="cf-why-because"><span className="faint">Because</span>{d.whyTarget.companyRanking.because.map((b) => <span key={b} className="cf-why-b">{b}</span>)}
            {o1Conclusive && <span className="cf-why-b">O1 counts {o1Conclusive} of them as conclusive</span>}</span>
        </section>
      )}

      <div className="cf-bottom">
        <DominoGraph desk={desk} dossier={d ?? null} />
        <Flows d={d} desk={desk} ev={ev} />
        <News d={d} ev={ev} name={company.name} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- headcount
function Headcount({ d, desk }: { d?: CompanyDossier | null; desk: CompanyDesk }) {
  const series = d?.headcountSeries ?? [];
  const last = series[series.length - 1];
  // The 90-day change the restructure guard uses: the latest point vs the latest point at least 80 days earlier.
  const base = last ? [...series].reverse().find((p) => daysBetween(p.date, last.date) >= 80) : undefined;
  const change = last && base && base.count > 0 ? ((last.count - base.count) / base.count) * 100 : null;
  const evId = d?.timeline.find((t) => t.kind === 'headcount_jump')?.evidenceIds[0] ?? null;
  const latest = last?.count ?? d?.company.headcount ?? desk.company.headcount ?? null;

  return (
    <section className="panel cf-p" data-testid="file-headcount">
      <header><h2>Headcount</h2>{evId ? <button className="srclink" onClick={() => openEvidence(evId)}>company/enrich timeseries</button> : <span className="faint">company/enrich</span>}</header>
      {latest == null ? (
        <p className="cf-empty">No headcount in this {d ? 'file' : 'view'}.</p>
      ) : (
        <div className="cf-hc">
          <div className="cf-hc-row">
            <span className="cf-big num">{fmtInt(latest)}</span>
            <span className="cf-hc-date">{last ? fmtDate(last.date, true) : 'latest record'}</span>
            {change != null && base && (
              <span className={`cf-delta ${change <= -10 ? 'down' : ''}`}>{pct1(change)} since {fmtDate(base.date, true)}</span>
            )}
          </div>
          {series.length >= 2
            ? <Spark series={series} mark={base?.date ?? null} onOpen={evId ? () => openEvidence(evId) : undefined} />
            : <p className="cf-empty sm">Headcount series not read in this scan, so no curve is drawn.</p>}
        </div>
      )}
    </section>
  );
}

function Spark({ series, mark, onOpen }: { series: { date: string; count: number }[]; mark: string | null; onOpen?: () => void }) {
  const t0 = Date.parse(series[0].date), t1 = Date.parse(series[series.length - 1].date);
  const lo = Math.min(...series.map((p) => p.count)), hi = Math.max(...series.map((p) => p.count));
  const pad = Math.max(1, (hi - lo) * 0.25);
  const x = (d: string) => ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * 100;
  const y = (c: number) => 100 - ((c - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const pts = series.map((p) => `${x(p.date).toFixed(2)},${y(p.count).toFixed(2)}`).join(' ');
  const m = mark ? series.find((p) => p.date === mark) : undefined;
  const end = series[series.length - 1];
  return (
    <button className="cf-spark" onClick={onOpen} disabled={!onOpen}
      aria-label={`Headcount from ${fmtDate(series[0].date, true)} to ${fmtDate(end.date, true)}, ${series.length} dated points. Open the source.`}>
      <span className="cf-spark-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {m && <line x1={x(m.date)} x2={x(m.date)} y1="0" y2="100" className="cf-spark-m" vectorEffect="non-scaling-stroke" />}
          <polyline points={pts} vectorEffect="non-scaling-stroke" />
        </svg>
        {m && <span className="cf-spark-ml" style={{ left: `${x(m.date)}%` }}>{fmtDate(m.date)} · {fmtInt(m.count)}</span>}
        {series.map((p) => <i key={p.date} className={`cf-dot ${p === end ? 'end' : ''}`} style={{ left: `${x(p.date)}%`, top: `${y(p.count)}%` }} title={`${fmtInt(p.count)} on ${fmtDate(p.date, true)}`} />)}
      </span>
      <span className="cf-spark-ax"><span>{fmtDate(series[0].date, true)}</span><span>{plural(series.length, 'dated point')}</span><span>{fmtDate(end.date, true)}</span></span>
    </button>
  );
}

// ---------------------------------------------------------------- funding
const hasFunding = (d?: CompanyDossier | null) => !!d && (d.timeline.some((t) => t.kind === 'funding') || !!d.company.lastFunding?.date);
function Funding({ d }: { d?: CompanyDossier | null }) {
  const rows = (d?.timeline ?? []).filter((t) => t.kind === 'funding');
  const lf = d?.company.lastFunding;
  return (
    <section className="panel cf-p" data-testid="file-funding">
      <header><h2>Funding</h2><span className="faint">company/enrich</span></header>
      {rows.length ? (
        <ul className="cf-rows">{rows.map((r) => <EventRow key={r.id} e={r} />)}</ul>
      ) : lf?.date ? (
        <ul className="cf-rows"><li className="cf-row"><span>{lf.round ?? 'Funding round'}</span><span className="mono cf-date">{fmtDate(lf.date, true)}</span></li></ul>
      ) : (
        <div className="cf-empty">
          <b>No dated funding record in this {d ? 'file' : 'view'}.</b>
          {d?.source === 'openings_scan' && <span>The openings scan reads departures, headcount and replacement searches. A company analysis run reads funding.</span>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- rules
const STATE: Record<DossierRule['state'], { label: string; cls: string }> = {
  open: { label: 'Provisional', cls: 'ctag tone-provisional' },
  held: { label: 'Held', cls: 'ctag tone-held' },
  met: { label: 'Met', cls: 'ctag tone-met' },
  not_met: { label: 'Not met', cls: 'ctag tone-not-met' },
  not_evaluated: { label: 'Not evaluated', cls: 'ctag tone-not-evaluated' },
};
const CLAUSE: Record<RuleClause['state'], { sym: string; cls: string; label: string }> = {
  met: { sym: '✓', cls: 'tick', label: 'Met' },
  open: { sym: '○', cls: 'cf-open', label: 'Open' },
  failed: { sym: '✗', cls: 'cf-fail', label: 'Failed' },
  cant_verify: { sym: '?', cls: 'cf-open', label: 'Can’t verify' },
};

/** The company view's O1 opening as a rule row, used only when the file itself didn't load. */
function o1FromDesk(desk: CompanyDesk): DossierRule | null {
  const o = desk.openings[0];
  if (!o) return null;
  const state: DossierRule['state'] = o.status === 'held' ? 'held' : o.status === 'watch' ? 'not_met' : o.provisional ? 'open' : 'met';
  const summary = o.status === 'held' ? `Held: ${(o.holdReasons ?? []).join('; ')}` : o.provisional && o.windowClosesBy ? `Predicted opening (provisional): window closes by ${fmtDate(o.windowClosesBy, true)}` : '';
  return { id: 'O1', name: 'Predicted opening', state, summary, clauses: o.clauses ?? [] };
}

function Rules({ rules, fromDesk, name, open, onToggle, family, ev }: { rules: DossierRule[]; fromDesk: boolean; name: string; open: string | null; onToggle: (id: string) => void; family: string | null; ev: EvMap }) {
  return (
    <section className="panel cf-p" data-testid="file-rules">
      <header><h2>Rules on this company</h2><span className="faint">clauses, not scores</span></header>
      {!rules.length ? (
        <p className="cf-empty">No rule has run on {name} in this view.</p>
      ) : (
        <ul className="cf-rules">
          {rules.map((r) => {
            const met = r.clauses.filter((c) => c.state === 'met').length;
            const tally = r.id === 'R1' && r.clauses[0] ? r.clauses[0].text.replace(/ conclusive departures$/, ' conclusive departures') : r.clauses.length ? `${met} of ${r.clauses.length} evaluated clauses met` : 'needs a company analysis run';
            const decided = decidingFact(r);
            const proofId = r.state === 'held' ? r.clauses.find((c) => c.state === 'failed' && c.evidenceIds.length)?.evidenceIds[0] : undefined;
            const x = open === r.id;
            return (
              <li key={r.id} className={`cf-rule ${x ? 'x' : ''}`} data-testid={`file-rule-${r.id}`}>
                <button className="cf-rule-btn" aria-expanded={x} aria-controls="cf-rule-detail" onClick={() => onToggle(r.id)}>
                  <span className="cf-rule-name"><b>{r.id}</b>{r.id.length <= 3 && <> {r.id === 'O1' && family ? `${family} opening` : r.name.toLowerCase()}</>}</span>
                  <span className={STATE[r.state].cls}>{STATE[r.state].label}</span>
                  <span className="cf-chev" aria-hidden>›</span>
                  <span className="cf-rule-tally">{r.id.length > 3 && `${r.name.toLowerCase()} · `}{tally}</span>
                  {decided && <span className="cf-rule-fact">{decided}</span>}
                </button>
                {proofId && <div className="cf-rule-proof"><Sources ids={[proofId]} ev={ev} /></div>}
              </li>
            );
          })}
          {fromDesk && <li className="cf-empty sm">R1, CONTAGION and DISPLACEMENT come with the company file, which isn’t loaded.</li>}
        </ul>
      )}
    </section>
  );
}

/** The one fact that decided a rule, shown on its collapsed row: the open window, or the failed guards. */
function decidingFact(r: DossierRule): string | null {
  if (r.state === 'open') { const w = r.clauses.find((c) => c.state === 'open'); return w ? w.text.replace(/^.*?:\s*/, '').replace(/^closes/, 'Window closes') : null; }
  if (r.state === 'held') {
    const f = r.clauses.filter((c) => c.state === 'failed').map((c) => c.text.replace(/\s*\(.*\)$/, '').replace(/:.*$/, ''));
    return f.length ? f.join(' · ') : null;
  }
  return null;
}
/** "Acqui-hire: “long headline” (thenextweb.com) (21 Aug 2026)" -> "Acqui-hire · thenextweb.com · 21 Aug 2026". The headline stays in the clause and its source. */
const shortHold = (h: string) => {
  const m = h.match(/^(.*?):\s*“.*”\s*\(([^)]+)\)\s*\(([^)]+)\)\s*$/);
  return m ? `${m[1]} · ${m[2]} · ${m[3]}` : h;
};

/** The opened rule: its summary and every clause with its state, date math and sources. Full width under the top row. */
function RuleDetail({ r, ev, onClose }: { r: DossierRule; ev: EvMap; onClose: () => void }) {
  return (
    <section className="panel cf-rd" id="cf-rule-detail" data-testid="file-rule-detail">
      <header>
        <h2><span>{r.id} · {r.name}</span> <span className={STATE[r.state].cls}>{STATE[r.state].label}</span></h2>
        <button className="btn small ghost" onClick={onClose}>Close</button>
      </header>
      <div className="cf-rd-body">
        {r.summary && (r.state === 'held' && r.summary.includes('; ')
          ? <ul className="cf-rule-sum cf-holds">{r.summary.replace(/^Held:\s*/, '').split('; ').map((h) => <li key={h}>{shortHold(h)}</li>)}</ul>
          : <p className="cf-rule-sum">{r.summary}</p>)}
        {r.clauses.length > 0 ? (
          <ul className="cf-clauses">
            {r.clauses.map((c) => (
              <li key={c.id} className={`c-${c.state}`}>
                <span className={`cf-cs ${CLAUSE[c.state].cls}`}>{CLAUSE[c.state].sym} {CLAUSE[c.state].label}</span>
                <span>
                  {c.state === 'cant_verify' ? <><span className="struck">{c.text}</span><span className="cant">I can’t verify</span></> : c.text}
                  {c.detail && <span className="cf-clause-d">{prettyDates(c.detail)}</span>}
                  {c.evidenceIds.length > 0 && <Sources ids={c.evidenceIds} ev={ev} />}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="cf-empty sm">No clauses were evaluated for {r.id} on this company.</p>}
      </div>
    </section>
  );
}

function Sources({ ids, ev }: { ids: string[]; ev: EvMap }) {
  return (
    <span className="cf-srcs">
      {ids.map((id) => {
        const e = ev.get(id);
        return (
          <button key={id} className="srclink" onClick={() => openEvidence(id)}>
            {e ? `${when(e.observedAt, isMonth(e))} · ${hostOf(e) ?? sourceName(e.source.endpoint, e.source.provider)}` : 'open source'}
          </button>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------- talent flows
interface FlowRow { key: string; dir: 'in' | 'out'; role: string; initial: string | null; other: string | null; date: string | null; month: boolean; evId: string | null }

function Flows({ d, desk, ev }: { d?: CompanyDossier | null; desk: CompanyDesk; ev: EvMap }) {
  // For a departure the dated fact is the month the person LEFT (the evidence's end date); the flow's own date is
  // when the next role started. Show the month they left so it matches the rule clauses ("Oct, Oct").
  const rows: FlowRow[] = d
    ? d.talentFlows.map((f, i) => {
      const e = ev.get(f.evidenceIds[0] ?? '');
      const date = f.direction === 'out' && e?.observedAt ? e.observedAt : f.date;
      return { key: f.evidenceIds[0] ?? String(i), dir: f.direction, role: f.role, initial: f.initial, other: f.otherCompanyName, date, month: f.precision === 'month' || isMonth(e), evId: f.evidenceIds[0] ?? null };
    })
    : desk.departures.map((p: Departure) => {
      const e = ev.get(p.evidenceId);
      return { key: p.id, dir: 'out' as const, role: p.role, initial: p.initial, other: p.toCompanyName, date: e?.observedAt ?? p.date, month: p.precision === 'month' || isMonth(e), evId: p.evidenceId };
    });
  rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const outs = rows.filter((r) => r.dir === 'out').length;
  const allMonth = rows.length > 0 && rows.every((r) => r.month);
  const ins = rows.length - outs;

  return (
    <section className="panel cf-p" data-testid="file-flows">
      <header><h2>Talent flows, last 90 days</h2><span className="faint">{outs} out · {ins} in · person search</span></header>
      {rows.length ? (
        <table className="t cf-t">
          <thead><tr><th>Direction</th><th>Person</th><th>Company</th><th>{ins ? 'Month' : 'Left in'}</th><th><span className="sr">Source</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.evId ? 'cf-click' : ''} tabIndex={r.evId ? 0 : undefined}
                onClick={r.evId ? () => openEvidence(r.evId!) : undefined}
                onKeyDown={r.evId ? (e) => { if (e.key === 'Enter') openEvidence(r.evId!); } : undefined}>
                <td><span className={`cf-dir ${r.dir}`}>{r.dir}</span></td>
                <td>{r.initial ? `${r.initial}, ` : ''}{r.role}</td>
                <td>{r.other ? `${r.dir === 'out' ? 'to' : 'from'} ${r.other}` : <span className="faint">not recorded</span>}</td>
                <td className="mono cf-date">{when(r.date, r.month)}</td>
                <td>{r.evId && <span className="srclink">Source</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="cf-empty">No dated move in or out of this company in the last 90 days.</p>
      )}
      <p className="cf-foot">
        People appear as role and initial. {allMonth && <>Dates are month-level <span className="tag">month-level date</span> (Crustdata person search). </>}Click a row for its record.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- news and checks
const KIND_LABEL: Partial<Record<DossierEvent['kind'], string>> = { news: 'News', check: 'Check', headcount_jump: 'Headcount', funding: 'Funding', job_post: 'Job post' };

function News({ d, ev, name }: { d?: CompanyDossier | null; ev: EvMap; name: string }) {
  const rows = d ? [...d.timeline.filter((t) => t.kind !== 'departure' && t.kind !== 'hire'), ...d.jobPosts] : [];
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const news = rows.filter((r) => r.kind === 'news').length;
  return (
    <section className="panel cf-p" data-testid="file-news">
      <header><h2>News and checks, dated</h2><span className="faint">{d ? `${plural(news, 'article')} · ${plural(rows.length - news, 'other record')}` : 'unavailable'}</span></header>
      {rows.length ? (
        <ul className="cf-news">
          {rows.map((r) => {
            const e = ev.get(r.evidenceIds[0] ?? '');
            const host = e ? hostOf(e) : null;
            const id = r.evidenceIds[0];
            return (
              <li key={r.id}>
                <button className="cf-news-row" disabled={!id} onClick={id ? () => openEvidence(id) : undefined}>
                  <span className="mono cf-date">{when(r.date, isMonth(e))}</span>
                  <span className={`cf-kind k-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
                  <span className="cf-news-t">{factLine(r.summary)}</span>
                  <span className="cf-news-src">{host ?? (e ? sourceName(e.source.endpoint, e.source.provider) : 'no source row')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="cf-empty">{d ? `No dated news, check or headcount record for ${name} in this file.` : 'Not loaded: news and checks come with the company file.'}</p>
      )}
      {d && news === 0 && rows.length > 0 && <p className="cf-foot">No dated news article about {name} in this file. The rows above are the run’s own searches and the headcount record.</p>}
    </section>
  );
}

function EventRow({ e }: { e: DossierEvent }) {
  const id = e.evidenceIds[0];
  return (
    <li className="cf-row">
      <button className="cf-row-btn" disabled={!id} onClick={id ? () => openEvidence(id) : undefined}>
        <span>{prettyDates(e.summary)}</span><span className="mono cf-date">{fmtDate(e.date, true)}</span>
      </button>
    </li>
  );
}
