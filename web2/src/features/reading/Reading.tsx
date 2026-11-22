// FEATURE 3: Reading log + Run desk (design mock screen 5). The O1 funnel from GET /api/openings/funnel (every count
// opens its records), a decision table that gives discards the same weight as kept rows, and the run desk: re-run
// the scan, or start an outbound "find buyers" run, and watch its reads stream into the same table.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'react-apexcharts';
import type { CompanyDesk, CompanySummary } from '../../data/desk.ts';
import { deskApi, invalidate, useQuery } from '../../data/query.ts';
import { runStore, useRunSel } from '../../data/store.ts';
import { fmtInt, plural } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { SourceNote } from '../../shell/SourceNote.tsx';
import { openEvidence } from '../../shell/ui.ts';
import { DECISION_STAGES, STAGE_HOW, loadFunnel, lockedShort, readRow, shortLabel, stageRows, tally } from './model.ts';
import type { Decision, FunnelStage, LogRow, OpeningsFunnel } from './model.ts';
import './reading.css';

const WINDOW = 200;
const READS = 'reads';
type Filter = Decision | 'all';
type Intent = NonNullable<ReturnType<typeof runStore.get>['ui']['snap']['intent']>;

export function Reading({ desk }: { desk: CompanyDesk }) {
  const fq = useQuery<OpeningsFunnel>('openings-funnel', loadFunnel);
  const companies = useQuery<CompanySummary[]>('companies', () => deskApi.companies());
  const runId = useRunSel((v) => v.runId);
  const status = useRunSel((v) => v.ui.snap.status);
  const intent = useRunSel((v) => v.ui.snap.intent);
  const storeError = useRunSel((v) => v.error);
  const funnel = fq.data;
  const missing = !!fq.error && !funnel && /no funnel/.test(fq.error);
  const playing = useRunSel((v) => v.playing);
  const live = !!runId && (status === 'running' || status === 'queued' || playing);

  // ---------------------------------------------------------------- selection
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const defaultView = useMemo(() => {
    if (!funnel || live) return READS;
    return funnel.stages.find((s) => s.id === 'window')?.id ?? funnel.stages.find((s) => s.rows?.length)?.id ?? READS;
  }, [funnel, live]);
  const view = missing ? READS : picked ?? defaultView;
  const pick = (id: string) => { setPicked(id); setFilter('all'); };
  // A run that streamed into the read log stays there when it finishes, rather than jumping to a funnel stage.
  useEffect(() => { if (live && picked == null) setPicked(READS); }, [live, picked]);

  // ---------------------------------------------------------------- run desk
  const [act, setAct] = useState<{ state: 'idle' | 'scan' | 'buyers'; error: string | null }>({ state: 'idle', error: null });
  const [request, setRequest] = useState('');
  const runAgain = async () => {
    setAct({ state: 'scan', error: null });
    const r = await deskApi.scanOpenings();
    if (!r) { setAct({ state: 'idle', error: 'The scan didn’t start: POST /api/openings/scan failed. Check that the DOMINO server is running, then try again.' }); return; }
    pick(READS);
    await runStore.attach(r.runId);
    setAct({ state: 'idle', error: null });
  };
  const findBuyers = async () => {
    const text = request.trim();
    if (!text) return;
    setAct({ state: 'buyers', error: null });
    try {
      await runStore.startRun(text);
      pick(READS);
      setAct({ state: 'idle', error: null });
    } catch (e) {
      setAct({ state: 'idle', error: `The run didn’t start: ${(e as Error).message}. Check the server and try again.` });
    }
  };
  // A finished re-scan replaces the cached funnel: refetch it once the new scan completes.
  const refetched = useRef<string | null>(null);
  useEffect(() => {
    if (status === 'completed' && runId && funnel && runId !== funnel.runId && refetched.current !== runId && !intent) {
      refetched.current = runId;
      invalidate('openings-funnel');
    }
  }, [status, runId, funnel, intent]);

  const runLabel = (runId ?? funnel?.runId ?? desk.runId ?? '').slice(0, 12);
  const domainOf = useMemo(() => {
    const m = new Map((companies.data ?? []).map((c) => [c.name.toLowerCase(), c.domain ?? null]));
    return (name: string) => m.get(name.toLowerCase()) ?? null;
  }, [companies.data]);
  const modelAdded = (intent as (Intent & { modelAdded?: string[] }) | null)?.modelAdded;

  return (
    <div className="rd">
      <div className="ph rd-ph">
        <div>
          <h1>Reading log</h1>
          <p>{runLabel ? <>Everything <span className="rd-run">{runLabel}</span> read, and what each rule kept or discarded.</> : 'Everything a run reads, and what each rule kept or discarded.'}</p>
          <SourceNote source={fq.source} error={fq.error && !missing ? fq.error : null} onRetry={() => invalidate('openings-funnel')} />
        </div>
        <div className="rd-desk">
          <form className="rd-ask" onSubmit={(e) => { e.preventDefault(); void findBuyers(); }}>
            <input
              value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Find buyers: describe what you sell"
              aria-label="Find buyers: describe what you sell" data-testid="find-buyers-input" maxLength={600}
            />
            <button className="btn" type="submit" disabled={!request.trim() || act.state !== 'idle'} data-testid="find-buyers-run">
              {act.state === 'buyers' ? 'Starting…' : 'Find buyers'}
            </button>
          </form>
          <button className="btn pri" onClick={runAgain} disabled={act.state !== 'idle' || live} data-testid="run-again">
            {act.state === 'scan' ? 'Starting the scan…' : live ? 'Running…' : 'Re-run from cache · 0 credits'}
          </button>
        </div>
      </div>
      {(act.error || storeError) && <p className="rd-err" role="alert">{act.error ?? storeError}</p>}
      {intent && intent.signalKeywords?.length > 0 && <Filters intent={intent} added={modelAdded} />}

      {!funnel && !missing && !fq.error && <div className="funnel rd-ghost" aria-hidden>{Array.from({ length: 6 }, (_, i) => <div key={i}><b>&nbsp;</b><span>&nbsp;</span><div className="rd-bar" /></div>)}</div>}
      {missing && !runId && (
        <div className="empty-act rd-empty" data-testid="reading-empty">
          <h2>No scan has run yet</h2>
          <p>The O1 scan reads the latest dated job moves from Crustdata and applies the rule. Every record it reads lands here, kept or discarded, with the rule’s reason.</p>
          <button className="btn pri" onClick={runAgain} disabled={act.state !== 'idle'}>{act.state === 'scan' ? 'Starting the scan…' : 'Run the scan from cache · 0 credits'}</button>
        </div>
      )}
      {missing && !runId && (
        <div className="panel rd-panel rd-waiting" aria-hidden>
          <table className="t rd-table">
            <colgroup><col className="c-src" /><col className="c-title" /><col className="c-date" /><col className="c-dom" /><col className="c-dec" /><col className="c-why" /></colgroup>
            <thead><tr><th>Source type</th><th>Title</th><th>Date</th><th>Domain</th><th>Kept or discarded</th><th>Why</th></tr></thead>
            <tbody>{Array.from({ length: 5 }, (_, i) => <tr key={i}>{Array.from({ length: 6 }, (_, j) => <td key={j}><i /></td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {missing && runId && <p className="rd-note" data-testid="funnel-missing">The funnel isn’t on this server (GET /api/openings/funnel answered 404). Below is everything {runLabel} read.</p>}
      {funnel && <FunnelStrip funnel={funnel} view={view} onPick={pick} />}

      {(funnel || runId) && (
        <DecisionTable funnel={funnel} view={view} filter={filter} onFilter={setFilter} domainOf={domainOf} runLabel={runLabel} live={live} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- effective filters

function Filters({ intent, added }: { intent: Intent; added?: string[] }) {
  const extra = new Set((added ?? []).map((t) => t.toLowerCase()));
  return (
    <div className="rd-filters" data-testid="effective-filters">
      <span className="faint">Effective filters</span>
      <span className="rd-term">{intent.buyerProfile}</span>
      {intent.geography && <span className="rd-term">{intent.geography}</span>}
      <span className="rd-term">last {intent.windowDays} days</span>
      {intent.signalKeywords.map((k) => <span key={k} className={extra.has(k.toLowerCase()) ? 'rd-term added' : 'rd-term'}>{k}</span>)}
      {added && added.length > 0 && <span className="llm">Terms added by GPT-6 Luna (schema-checked)</span>}
    </div>
  );
}

// ---------------------------------------------------------------- funnel

function FunnelStrip({ funnel, view, onPick }: { funnel: OpeningsFunnel; view: string; onPick: (id: string) => void }) {
  const max = Math.max(1, ...funnel.stages.map((s) => s.count));
  const firstDecision = funnel.stages.findIndex((s) => DECISION_STAGES.has(s.id));
  const steps = funnel.stages.filter((s) => !DECISION_STAGES.has(s.id));
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <>
    <div className="rd-chart" role="group" aria-label="O1 funnel, proportional to the first stage" data-testid="reading-chart">
      <Chart type="bar" height={Math.max(150, steps.length * 38)} series={[{ name: 'Rows kept', data: steps.map((s) => s.count) }]}
        options={{
          chart: { toolbar: { show: false }, fontFamily: 'inherit', animations: { enabled: true, speed: 450, animateGradually: { enabled: true, delay: 60 }, dynamicAnimation: { enabled: false } },
            events: { dataPointSelection: (_e, _c, cfg) => { const s = steps[cfg?.dataPointIndex ?? -1]; if (s) onPick(s.rows?.length ? s.id : READS); } } },
          plotOptions: { bar: { horizontal: true, borderRadius: 3, barHeight: '62%', distributed: true } },
          colors: steps.map((s) => (view === (s.rows?.length ? s.id : READS) ? '#2e6be6' : '#12a594')),
          legend: { show: false }, grid: { borderColor: '#ebecef', strokeDashArray: 3, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
          dataLabels: { enabled: true, offsetX: 6, textAnchor: 'start', formatter: (v: number) => fmtInt(v), style: { fontSize: '12px', fontWeight: 600, colors: ['#1f2328'] } },
          xaxis: { categories: steps.map((s) => shortLabel(s)), labels: { formatter: (v: string) => fmtInt(Number(v)), style: { colors: '#8a8f98', fontSize: '11px' } } },
          yaxis: { labels: { maxWidth: 240, style: { colors: '#4b5059', fontSize: '12px' } } },
          tooltip: { y: { formatter: (v: number) => `${fmtInt(v)} · ${Math.round((v / top) * 1000) / 10}% of the first step · click to list these rows` } },
          states: { active: { filter: { type: 'none' } } },
        }} />
    </div>
    <div className="funnel rd-funnel" role="tablist" aria-label="O1 funnel">
      {funnel.stages.map((s, i) => {
        const id = s.rows?.length || DECISION_STAGES.has(s.id) ? s.id : READS;
        const on = view === id;
        const pct = s.count ? Math.max(1.5, (s.count / max) * 100) : 0;
        const how = STAGE_HOW[s.id];
        return (
          <div
            key={s.id} role="tab" tabIndex={0} aria-selected={on} title={how ? `${s.label}\n${how.clause}\nSource: ${how.source}\nGET /api/openings/funnel` : s.label}
            className={[on && 'on', i === firstDecision && 'rd-dec', `rd-${s.id}`].filter(Boolean).join(' ')}
            onClick={() => onPick(id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(id); } }}
            data-testid={`funnel-stage-${s.id}`}
          >
            <b data-num>{fmtInt(s.count)}</b>
            <span>{shortLabel(s)}</span>
            <div className="rd-bar"><i style={{ transform: `scaleX(${pct / 100})` }} /></div>
          </div>
        );
      })}
    </div>
    </>
  );
}

// ---------------------------------------------------------------- decision table

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'kept', label: 'Kept' }, { id: 'provisional', label: 'Provisional' }, { id: 'discarded', label: 'Discarded' },
  { id: 'held', label: 'Held' }, { id: 'inconclusive', label: 'Not conclusive' },
];

function DecisionTable({ funnel, view, filter, onFilter, domainOf, runLabel, live }: {
  funnel: OpeningsFunnel | null; view: string; filter: Filter; onFilter: (f: Filter) => void;
  domainOf: (c: string) => string | null; runLabel: string; live: boolean;
}) {
  const sources = useRunSel((v) => v.feeds.sources);
  const reads = useRunSel((v) => v.feeds.reads);
  const slow = useRunSel((v) => v.feeds.slow);
  const catchingUp = useRunSel((v) => v.catchingUp);
  const [limit, setLimit] = useState(WINDOW);
  useEffect(() => { setLimit(WINDOW); }, [view, filter]);

  const idx = funnel ? funnel.stages.findIndex((s) => s.id === view) : -1;
  const stage: FunnelStage | null = idx >= 0 && funnel ? funnel.stages[idx] : null;
  const sv = useMemo(() => (stage && funnel ? stageRows(funnel.stages, idx, domainOf) : null), [stage, funnel, idx, domainOf]);
  // Read rows are mapped once per card and cached by key, so a streamed append doesn't rebuild old rows.
  const cache = useRef(new Map<string, LogRow>());
  const readRows = useMemo(() => sources.map((c) => {
    let r = cache.current.get(c.key);
    if (!r) { r = readRow(c); cache.current.set(c.key, r); }
    return r;
  }), [sources]);

  const all = sv ? sv.rows : readRows;
  const t = tally(all);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'scan' | 'title' | 'decision'>('scan');
  const needle = q.trim().toLowerCase();
  const byDecision = filter === 'all' ? all : all.filter((r) => r.decision === filter);
  const searched = needle ? byDecision.filter((r) => `${r.title} ${r.domain ?? ''} ${r.source} ${r.why.join(' ')}`.toLowerCase().includes(needle)) : byDecision;
  const filtered = sort === 'scan' ? searched : [...searched].sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title) : a.decision.localeCompare(b.decision)));
  // Stage records page forward from the top; a streaming read log keeps its newest WINDOW rows.
  const shown = sv ? filtered.slice(0, limit) : filtered.slice(-WINDOW);
  const of = filter === 'all' ? all.length : filtered.length;

  const inGroups = stage?.id === 'groups' ? t.kept + t.inconclusive : 0;
  const title = stage
    ? <>{fmtInt(stage.count)} {shortLabel(stage)}{inGroups ? `, from ${fmtInt(inGroups)} departures` : ''}</>
    : <>{fmtInt(readRows.length)} records {runLabel || 'this run'} read</>;
  // The scan pages through every job move but itemises only some: say how many of the funnel's first count are listed.
  const reported = funnel && funnel.stages[0]?.id === 'profiles' ? funnel.stages[0].count : 0;
  const decisionStage = !!stage && DECISION_STAGES.has(stage.id);
  const unit = decisionStage ? 'companies' : 'rows';
  const subs = decisionStage ? all.filter((r) => r.sub).length : 0;
  const showing = decisionStage
    ? `showing ${fmtInt(all.length - subs)}${subs ? `, with the ${fmtInt(subs)} departures behind ${all.length - subs === 1 ? 'it' : 'them'}` : ''}`
    : shown.length < of ? `showing ${fmtInt(shown.length)} of ${fmtInt(of)} rows` : `all ${plural(of, 'row')} shown`;

  return (
    <div className="panel rd-panel">
      <header>
        <div className="rd-head">
          <h2 data-testid="reading-title">{title} <span className="faint rd-showing">· {showing}</span></h2>
          {!decisionStage && FILTERS.filter((f) => f.id !== 'all' && t[f.id] > 0).length > 1 && (
            <div className="rd-seg" role="group" aria-label="Filter by decision">
              {FILTERS.filter((f) => f.id === 'all' || t[f.id] > 0).map((f) => (
                <button key={f.id} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)} data-testid={`reading-filter-${f.id}`}>
                  {f.label} <span data-num>{fmtInt(t[f.id])}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {funnel && stage ? (
          <span className="faint rd-lock" title={`Locked ${funnel.lockedAt}`}>{funnel.rule} · pre-registered {lockedShort(funnel.lockedAt)}</span>
        ) : (
          <span className="faint rd-lock">{live ? <><i className="rd-dot" aria-hidden /> Reading{reads.latestQuery ? `: ${reads.latestQuery.split(' — ')[0]}` : '…'}</> : `${fmtInt(reads.sourceReads)} source reads`}</span>
        )}
      </header>
      {slow && !stage && <p className="rd-slow" role="status">{slow.text}</p>}
      <div className="rd-tools">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, domain, reason" aria-label="Search the log" />
        <label className="faint">Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="scan">Scan order</option><option value="title">Title A–Z</option><option value="decision">Decision</option>
          </select>
        </label>
        {needle && <span className="faint">{fmtInt(filtered.length)} match{filtered.length === 1 ? '' : 'es'}</span>}
      </div>
      {stage && (
        <p className="rd-def">
          <b>{stage.label}</b>
          {STAGE_HOW[stage.id] && <> · {STAGE_HOW[stage.id].clause} · source: {STAGE_HOW[stage.id].source}</>}
          <span className="mono"> · GET /api/openings/funnel</span>
        </p>
      )}
      <table className="t rd-table">
        <colgroup><col className="c-src" /><col className="c-title" /><col className="c-date" /><col className="c-dom" /><col className="c-dec" /><col className="c-why" /></colgroup>
        <thead><tr><th>Source type</th><th>Title</th><th>Date</th><th>Domain</th><th>Kept or discarded</th><th>Why</th></tr></thead>
        <Body key={`${view}:${filter}`} rows={shown} streaming={!stage && live} catchingUp={catchingUp} />
      </table>
      {!shown.length && (
        <p className="rd-none" data-testid="reading-none">
          {stage ? (DECISION_STAGES.has(stage.id) ? `No company reached this decision in ${funnel?.runId.slice(0, 12)}. Zero is a result: the rule abstained.` : 'This step lists no records.')
            : live ? 'Waiting for the first read…' : 'This run has no source reads yet.'}
        </p>
      )}
      <footer className="rd-foot">
        {!stage && reported > 0 && readRows.length > 0 && <span data-testid="reads-itemised">Crustdata reported {fmtInt(reported)} job moves; this log lists the {fmtInt(readRows.length)} records the run itemised, kept or discarded.</span>}
        {sv && sv.unlisted > 0 && <span>{fmtInt(sv.unlisted)} job moves dropped at this step aren’t itemised by the scan; the {fmtInt(stage!.count)} that passed are listed.</span>}
        {all.some((r) => r.monthLevel) && <span>A date shown as a month (Oct 2026) is a month-level date: the source gives no day.</span>}
        {sv && filtered.length > shown.length && (
          <button className="btn small" onClick={() => setLimit((n) => n + WINDOW)}>Show the next {fmtInt(Math.min(WINDOW, filtered.length - shown.length))} {unit}</button>
        )}
      </footer>
    </div>
  );
}

/** One tbody per view: switching stage fades the body once; streamed rows inside it enter once each. */
function Body({ rows, streaming, catchingUp }: { rows: LogRow[]; streaming: boolean; catchingUp: boolean }) {
  const first = useRef(true);
  useEffect(() => { first.current = false; }, []);
  const settled = first.current || catchingUp || !streaming;
  return <tbody className="rd-body">{rows.map((r) => <Row key={r.key} r={r} settled={settled} />)}</tbody>;
}

const Row = memo(function Row({ r, settled }: { r: LogRow; settled: boolean }) {
  const ref = useEnterOnce<HTMLTableRowElement>(settled);
  const open = r.evidenceId ? () => openEvidence(r.evidenceId!) : undefined;
  return (
    <tr ref={ref} data-testid="reading-row" data-decision={r.decision} className={[open && 'rd-open', r.sub && 'rd-sub'].filter(Boolean).join(' ') || undefined}
      onClick={open} tabIndex={open ? 0 : undefined} onKeyDown={open ? (e) => { if (e.key === 'Enter') open(); } : undefined}>
      <td className="rd-src"><span className={`ctag ${srcClass(r.source)}`}>{r.source}</span></td>
      <td className="rd-title" title={r.title}>{r.title}</td>
      <td className="rd-date" title={r.monthLevel ? 'month-level date' : undefined}>{r.date}</td>
      <td className={r.domain ? 'mono rd-dom' : 'faint'} title={r.domain ?? 'no domain on record'}>{r.domain ?? '–'}</td>
      <td className="rd-dec"><DecisionMark d={r.decision} why={r.why[0]} /></td>
      <td className="muted rd-why">{r.why.map((w, i) => <Clause key={i} text={w} />)}</td>
    </tr>
  );
});

/** A rule clause line. The engine marks met clauses "✓" and open ones "⏳": show them as text marks, not emoji. */
function Clause({ text }: { text: string }) {
  if (text.startsWith('✓ ')) return <span><b className="tick">✓</b> {text.slice(2)}</span>;
  if (text.startsWith('⏳')) return <span><b className="rd-open-mark">open</b> {text.replace(/^⏳️?\s*/, '')}</span>;
  return <span>{text}</span>;
}

/** Decision and source chips use the shared colour classes (styles/colors.css): one hue per meaning on every screen. */
// Discarding is a rule outcome, not a failure: neutral grey, with its reason. Red stays for not met / can't verify.
const TONE: Record<Decision, string> = {
  kept: 'tone-met', provisional: 'tone-provisional', discarded: 'tone-not-evaluated', held: 'tone-held', inconclusive: 'tone-not-evaluated',
};
function DecisionMark({ d, why }: { d: Decision; why?: string }) {
  const reason = d === 'discarded' && why ? why.replace(/^(✓|⏳️?)\s*/, '') : '';
  const label = d === 'kept' ? 'kept at this step' : d === 'inconclusive' ? 'not conclusive' : d === 'discarded' ? (reason ? `Discarded · ${reason}` : 'Discarded') : d;
  return <span className={`ctag ${TONE[d]} rd-dec-tag`} title={label}>{label}</span>;
}

function srcClass(source: string): string {
  if (/^person/i.test(source)) return 'src-person';
  if (/^company/i.test(source)) return 'src-company';
  if (/^job/i.test(source)) return 'src-job';
  if (/news/i.test(source)) return 'src-news';
  if (/^web/i.test(source)) return 'src-web';
  if (/rule/i.test(source)) return 'rule-o1';
  return '';
}
