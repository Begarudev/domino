// FEATURE 8: ledger. One row per call of the run behind the page (credits, tokens, USD, latency, mode), the
// Used · Reserved · Cap strip against each cap, the call a cap refused, and the cost of a delivered intro.
// Reads the page's run from the run store; `?run=<id>` shows another run read-only (GET /api/runs/:id only).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BudgetState, LedgerEntry, RunSnapshot } from '../../../../shared/types.ts';
import { ENDPOINT_NOUN, STEP_PLAIN } from '../../data/derive.ts';
import { runStore, useRunSel } from '../../data/store.ts';
import { closeLedger, useShell } from '../../shell/ui.ts';
import { fmtCredits, fmtInt, fmtSeconds, fmtTime, fmtUsd, plural } from '../../lib/format.ts';
import { Count, ENTER, reducedMotion } from '../../lib/motion.ts';
import './ledger.css';

type Reserved = { credits: number; modelUsd: number };
type Budget = BudgetState & { reserved?: Reserved };
const CAP_NAME = { credits: 'credit cap', model_usd: 'model spend cap', seconds: 'time cap' } as const;
const STATUS: Record<LedgerEntry['status'], string> = {
  ok: 'OK', timeout: 'Timed out', error: 'Error', nonsense: 'Bad response', cache_hit: 'Cache hit', budget_blocked: 'Not dispatched',
};

function useLedgerRun(): { snap: RunSnapshot | null; external: boolean; error: string | null } {
  const storeSnap = useRunSel((v) => v.ui.snap);
  const storeRun = useRunSel((v) => v.runId);
  const urlRun = useMemo(() => new URLSearchParams(location.search).get('run'), []);
  const [ext, setExt] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const external = !!urlRun && urlRun !== storeRun;
  useEffect(() => {
    if (!external || !urlRun) return;
    let live = true;
    fetch(`/api/runs/${encodeURIComponent(urlRun)}`) // GET only
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s: RunSnapshot) => { if (live) setExt(s); })
      .catch((e: Error) => { if (live) setError(`run ${urlRun.slice(0, 12)} didn’t load (${e.message})`); });
    return () => { live = false; };
  }, [external, urlRun]);
  if (external) return { snap: ext, external, error };
  return { snap: storeSnap?.id ? storeSnap : null, external: false, error: null };
}

const stepName = (e: LedgerEntry) => (STEP_PLAIN as Record<string, string>)[e.step] ?? e.step.replace(/_/g, ' ');
const modeLabel = (e: LedgerEntry) =>
  e.mode === 'model' ? 'Model call' : e.mode === 'live' ? 'Live' : e.mode === 'cache' ? 'Cached' : e.mode === 'fixture' ? 'Fixture' : String(e.mode);
const isLlm = (e: LedgerEntry) => e.mode === 'model' || e.inputTokens + e.outputTokens > 0;
const requestLabel = (req: string) => (req.startsWith('intro:') ? 'Intro delivery' : req.startsWith('candidate:') ? 'Candidate read' : req);

export function LedgerTab() {
  const { snap, external, error } = useLedgerRun();
  if (error) return <p className="src-note bad" role="alert">The ledger couldn’t load: {error}. Check the run id in the address.</p>;
  if (!snap) return <p className="loading-line" role="status">Loading the ledger for this page’s run…</p>;
  return <LedgerView snap={snap} readOnly={external} />;
}

function LedgerView({ snap, readOnly }: { snap: RunSnapshot; readOnly: boolean }) {
  const b = snap.budget as Budget;
  const rows = snap.ledger ?? [];
  const reserved = b.reserved ?? { credits: 0, modelUsd: 0 };
  const credits = b.used.credits;
  const usd = b.used.modelUsd;
  const paid = rows.some((r) => r.credits > 0 || r.usd > 0);
  const blocked = rows.filter((r) => r.status === 'budget_blocked');
  const last = rows.length ? stepName(rows[rows.length - 1]).toLowerCase() : null;
  const running = snap.status === 'running';
  const delivered = (snap.outbox ?? []).length;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupRows(rows.filter(FILTER_FN[filter]).filter((r) => matches(r, q))), [rows, filter, q]);

  return (
    <div className="ledger">
      <RunPicker current={snap.id} />
      <div className="lg-kpis">
        <Kpi label="New credits" value={fmtCredits(credits)} sub={`of ${fmtInt(b.limits.maxCredits)} cap`} />
        <Kpi label="Model spend" value={fmtUsd(usd)} sub={`of ${fmtUsd(b.limits.maxModelUsd)} cap`} />
        <Kpi label="Time" value={`${fmtInt(b.used.seconds)} s`} sub={`of ${fmtInt(b.limits.maxSeconds)} s cap`} />
        <Kpi label="Calls" value={fmtInt(rows.length)} sub={`${rows.filter((r) => r.status === 'cache_hit').length} cache hits · ${blocked.length} blocked`} />
      </div>
      <details className="lg-how">
        <summary>How this is computed</summary>
        Reads GET /api/runs/:id (the run snapshot: budget and ledger) and GET /api/runs for the run list. Each row is one data call (Crustdata person search, company enrich, job search, news) or one GPT-6 Luna model call (parse, refine, draft), written when the call returns.
        Before a call is sent, the budget guard adds its estimated cost to what is used and reserved; if that would cross a cap the call is recorded as “Not dispatched” and spends nothing.
      </details>
      <div className="lg-run">
        <span className="st plain mono" title={snap.id}>{snap.id.slice(0, 12)}</span>
        <b className="lg-sum" data-testid="ledger-sum">{plural(rows.length, "call")} · {fmtCredits(credits)} new credits</b>
        <span className="lg-req">{requestLabel(snap.request)}</span>
        <span className={`st ${snap.status === 'budget_exhausted' ? 'held' : 'plain'}`}>
          {snap.status === 'budget_exhausted' ? `Stopped at the ${CAP_NAME[b.exhausted ?? 'credits']}` : snap.status.replace(/_/g, ' ')}
        </span>
        {readOnly && <span className="faint">Past run, read-only</span>}
      </div>

      <section className="panel lg-strip" aria-labelledby="lg-caps-h">
        <div className="lg-sec-h">
          <h2 id="lg-caps-h">Spend against the caps</h2>
          <span>What this run has used and reserved against its credit, model spend and time limits.</span>
        </div>
        <p className="lg-line" data-testid="cap-line">
          <span>Used <b><Count value={credits} format={fmtCredits} /></b> credits</span>
          <span className="sep">·</span>
          <span>Reserved <b>{fmtCredits(reserved.credits)}</b>
            {reserved.modelUsd > 0 && <> + <b>{fmtUsd(reserved.modelUsd)}</b> model</>}
            {running && (reserved.credits > 0 || reserved.modelUsd > 0) && last ? <span className="faint"> ({last} in flight)</span> : null}</span>
          <span className="sep">·</span>
          <span>Cap <b>{fmtInt(b.limits.maxCredits)}</b></span>
          <span className="sep">·</span>
          <span>Time left <b>{fmtInt(Math.max(0, b.limits.maxSeconds - b.used.seconds))} s</b></span>
        </p>
        <div className="lg-caps">
          <Cap testid="cap-credits" label="Credits" used={credits - reserved.credits} reserved={reserved.credits} cap={b.limits.maxCredits} fmt={fmtCredits} hit={b.exhausted === 'credits'} />
          <Cap testid="cap-usd" label="Model spend" used={usd - reserved.modelUsd} reserved={reserved.modelUsd} cap={b.limits.maxModelUsd} fmt={fmtUsd} hit={b.exhausted === 'model_usd'} />
          <Cap testid="cap-seconds" label="Time" used={b.used.seconds} reserved={0} cap={b.limits.maxSeconds} fmt={(s) => `${fmtInt(s)} s`} hit={b.exhausted === 'seconds'} />
        </div>
        <LowerCap spent={credits} cap={b.limits.maxCredits} enabled={running && !readOnly} />
      </section>

      {blocked.length ? blocked.map((r) => (
        <div className="blocked" key={`blk-${r.id}`} data-testid="blocked-call">
          <div>
            <b>Blocked before spend</b> · {stepName(r)} · <span className="mono">{r.endpoint}</span>
            <div className="faint">Credit cap {fmtInt(b.limits.maxCredits)} · used {fmtCredits(credits)} + would have cost ≈ {fmtCredits(r.credits)} = {fmtCredits(credits + r.credits)} · not dispatched</div>
          </div>
          <span className="ctag tone-held">Not dispatched</span>
        </div>
      )) : (
        <div className={`blocked${b.exhausted ? '' : ' quiet'}`} data-testid="blocked-call">
          <div>
            <b>{b.exhausted ? `This run stopped at the ${CAP_NAME[b.exhausted]}` : 'No call was blocked in this run'}</b>
            <div className="faint">A call that would cross a cap is refused before it spends and shows here as “Not dispatched”.
              {b.exhausted === 'seconds' ? ` It ran ${fmtInt(b.used.seconds)} s of ${fmtInt(b.limits.maxSeconds)} s; nothing after that was sent.` : ''}</div>
          </div>
          <span className={`ctag ${b.exhausted ? 'tone-held' : 'tone-met'}`}>{b.exhausted ? 'Cap reached' : 'Within caps'}</span>
        </div>
      )}

      {delivered > 0 && (
        <div className="receipt lg-intro" data-testid="intro-cost">
          <b>Cost of this intro: {fmtCredits(credits)} credits + {fmtUsd(usd)}</b>
          <span className="faint">{plural(delivered, 'delivery', 'deliveries')} to the team inbox · every call behind it is listed below</span>
        </div>
      )}

      <section className="panel">
        <header>
          <div className="lg-sec-h">
            <h2>{plural(rows.length, 'call')} in this run</h2>
            <span>Identical calls (same step, endpoint, mode and status) are grouped; open a group to see each call.</span>
          </div>
          {!paid && rows.length > 0 && <span className="lg-note" data-testid="cached-note">This scan reused cached live responses: 0 new credits</span>}
        </header>
        {rows.length === 0 ? (
          <p className="pad faint">This run made no paid calls. Rows appear here as each call returns, with its credits and cost.</p>
        ) : (
          <div className="lg-scroll" tabIndex={0} role="region" aria-label="Calls in this run">
          <div className="lg-tools">
            <input className="lg-search" type="search" placeholder="Search step, endpoint, status…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search calls" />
            {FILTERS.map(([k, label]) => (
              <button key={k} className={`lg-chip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label} <span className="faint">{rows.filter(FILTER_FN[k]).length}</span>
              </button>
            ))}
          </div>
          <table className="t lg-table">
            <thead><tr><th>Time</th><th>Step</th><th>Endpoint</th><th>Mode</th><th>Status</th><th className="num">Credits</th><th className="num">Tokens</th><th className="num">USD</th><th className="num">Latency</th></tr></thead>
            <tbody>
              {groups.length === 0 && <tr><td colSpan={9} className="faint">No call matches “{q}” with this filter.</td></tr>}
              {groups.map((g) => <Group key={g.key} g={g} open={!!openKeys[g.key]} toggle={() => setOpenKeys((o) => ({ ...o, [g.key]: !o[g.key] }))} />)}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}><b>Run total</b> <span className="faint">against the caps</span></td>
                <td className="num"><b>{fmtCredits(credits)}</b> <span className="faint">/ {fmtInt(b.limits.maxCredits)}</span></td>
                <td className="num">{fmtInt(rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0))}</td>
                <td className="num"><b>{fmtUsd(usd)}</b> <span className="faint">/ {fmtUsd(b.limits.maxModelUsd)}</span></td>
                <td className="num">{fmtInt(b.used.seconds)} s</td>
              </tr>
            </tfoot>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}

type FilterKey = 'all' | 'paid' | 'cache' | 'model' | 'problems';
const FILTERS: [FilterKey, string][] = [['all', 'All'], ['paid', 'Spent credits'], ['cache', 'Cache hit'], ['model', 'Model calls'], ['problems', 'Blocked or failed']];
const FILTER_FN: Record<FilterKey, (r: LedgerEntry) => boolean> = {
  all: () => true,
  paid: (r) => r.credits > 0,
  cache: (r) => r.status === 'cache_hit',
  model: (r) => isLlm(r),
  problems: (r) => r.status !== 'ok' && r.status !== 'cache_hit',
};
const matches = (r: LedgerEntry, q: string) => {
  const s = q.trim().toLowerCase();
  return !s || [stepName(r), r.step, r.endpoint, STATUS[r.status], modeLabel(r)].some((x) => x.toLowerCase().includes(s));
};
type Grp = { key: string; rows: LedgerEntry[] };
function groupRows(rows: LedgerEntry[]): Grp[] {
  const m = new Map<string, Grp>();
  for (const r of rows) {
    const key = `${r.step}|${r.endpoint}|${r.mode}|${r.status}|${r.injected ? 1 : 0}`;
    const g = m.get(key) ?? { key, rows: [] };
    g.rows.push(r);
    m.set(key, g);
  }
  // A call the cap refused leads the grid: it is the row a reader most needs to see.
  return [...m.values()].sort((a, b) => Number(b.rows[0].status === 'budget_blocked') - Number(a.rows[0].status === 'budget_blocked'));
}

function Group({ g, open, toggle }: { g: Grp; open: boolean; toggle: () => void }) {
  if (g.rows.length === 1) return <Row r={g.rows[0]} />;
  const r = g.rows[0];
  const sum = (f: (x: LedgerEntry) => number) => g.rows.reduce((s, x) => s + f(x), 0);
  const credits = sum((x) => x.credits), usd = sum((x) => x.usd), tok = sum((x) => x.inputTokens + x.outputTokens);
  const lat = sum((x) => x.latencyMs) / g.rows.length;
  const bad = r.status !== 'ok' && r.status !== 'cache_hit';
  return (
    <>
      <tr data-testid="ledger-group" className={`lg-grp${r.status === 'budget_blocked' ? ' blocked-row' : ''}`} onClick={toggle} aria-expanded={open}>
        <td className="lg-time"><button className="lg-x" aria-label={open ? 'Collapse' : 'Expand'}>{open ? '▾' : '▸'}</button> {fmtTime(r.ts)}</td>
        <td className="lg-step"><b className="lg-n">{g.rows.length} ×</b> {stepName(r)}</td>
        <td className="mono">{r.endpoint}</td>
        <td>{r.injected ? <span className="ctag tone-held">Injected fault</span> : modeLabel(r)}</td>
        <td><span className={`ctag ${r.status === 'budget_blocked' ? 'tone-held' : bad ? 'tone-not-met' : 'tone-met'}`}>{STATUS[r.status]}</span></td>
        <td className="num">{credits ? fmtCredits(credits) : <span className="faint">0</span>}</td>
        <td className="num">{tok ? fmtInt(tok) : <span className="faint">–</span>}</td>
        <td className="num">{usd ? fmtUsd(usd) : <span className="faint">$0</span>}</td>
        <td className="num" title="Average per call">{fmtSeconds(lat)} <span className="faint">avg</span></td>
      </tr>
      {open && g.rows.map((x) => <Row key={x.id} r={x} child />)}
    </>
  );
}

function RunPicker({ current }: { current: string }) {
  const [runs, setRuns] = useState<{ id: string; request: string; status: string; createdAt: string }[]>([]);
  useEffect(() => { fetch('/api/runs').then((r) => (r.ok ? r.json() : [])).then(setRuns).catch(() => setRuns([])); }, []);
  if (runs.length < 2) return null;
  return (
    <label className="lg-picker">
      <span>Run</span>
      <select value={current} onChange={(e) => { const u = new URL(location.href); u.searchParams.set('run', e.target.value); location.assign(u.toString()); }}>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>{r.id.slice(0, 12)} · {r.status.replace(/_/g, ' ')} · {new Date(r.createdAt).toLocaleString()} · {r.request.slice(0, 60)}</option>
        ))}
      </select>
      <span className="faint">{runs.length} runs</span>
    </label>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="lg-kpi"><span className="lg-kpi-l">{label}</span><b className="lg-kpi-v">{value}</b><span className="lg-kpi-s">{sub}</span></div>;
}

function Row({ r, child }: { r: LedgerEntry; child?: boolean }) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (!reducedMotion()) ref.current?.animate(ENTER, { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' }); }, []);
  const bad = r.status !== 'ok' && r.status !== 'cache_hit';
  return (
    <tr ref={ref} data-testid="ledger-row" className={[r.status === 'budget_blocked' ? 'blocked-row' : '', child ? 'lg-child' : ''].join(' ').trim() || undefined}>
      <td className="lg-time">{fmtTime(r.ts)}</td>
      <td className="lg-step" title={stepName(r)}>{stepName(r)}</td>
      <td className="mono" title={ENDPOINT_NOUN[r.endpoint] ?? r.endpoint}>{r.endpoint}</td>
      <td>{r.injected ? <span className="ctag tone-held">Injected fault</span> : modeLabel(r)}</td>
      <td><span className={`ctag ${r.status === 'budget_blocked' ? 'tone-held' : bad ? 'tone-not-met' : 'tone-met'}`}>{STATUS[r.status]}{r.attempt > 1 ? ` · try ${r.attempt}` : ''}</span></td>
      <td className="num">{r.credits ? fmtCredits(r.credits) : <span className="faint">0</span>}</td>
      <td className="num">{isLlm(r) ? fmtInt(r.inputTokens + r.outputTokens) : <span className="faint">–</span>}</td>
      <td className="num">{r.usd ? fmtUsd(r.usd) : <span className="faint">$0</span>}</td>
      <td className="num">{fmtSeconds(r.latencyMs)}</td>
    </tr>
  );
}

function Cap({ label, used, reserved, cap, fmt, hit, testid }: {
  label: string; used: number; reserved: number; cap: number; fmt: (n: number) => string; hit: boolean; testid: string;
}) {
  const pct = (n: number) => `${Math.min(100, Math.max(0, cap > 0 ? (n / cap) * 100 : 0))}%`;
  return (
    <div className={`lg-cap${hit ? ' hit' : ''}`} data-testid={testid}>
      <div className="lg-cap-h"><span>{label}</span><span className="num"><b>{fmt(used + reserved)}</b> of {fmt(cap)}</span></div>
      <div className="capbar" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used + reserved} aria-label={`${label} used`}>
        <i className="u" style={{ width: pct(used) }} />
        {reserved > 0 && <i className="r" style={{ width: pct(reserved) }} />}
      </div>
      <div className="lg-cap-n">{hit ? "Cap reached" : `${fmt(Math.max(0, cap - used - reserved))} left`}{reserved > 0 ? ` · ${fmt(reserved)} reserved` : ''}</div>
    </div>
  );
}

function LowerCap({ spent, cap, enabled }: { spent: number; cap: number; enabled: boolean }) {
  const [v, setV] = useState(String(cap));
  const [state, setState] = useState<'idle' | 'saving' | 'failed' | 'done'>('idle');
  const n = Number(v);
  const valid = Number.isFinite(n) && n >= Math.ceil(spent) && n < cap;
  const submit = async () => {
    if (!valid || !enabled) return;
    setState('saving');
    const r = await runStore.setLimits({ maxCredits: n }).catch(() => null);
    setState(r ? 'done' : 'failed');
  };
  // A finished run can't change its caps: say so in one line instead of showing a dead control.
  if (!enabled) return <p className="lg-lower faint">Caps can be lowered while a run is running; this run has finished.</p>;
  return (
    <div className="lg-lower">
      <label htmlFor="lg-cap-in">Lower the credit cap</label>
      <input id="lg-cap-in" className="mono" type="number" min={Math.ceil(spent)} max={cap} value={v} disabled={!enabled}
        onChange={(e) => { setV(e.target.value); setState('idle'); }} />
      <button className="btn sm" disabled={!enabled || !valid || state === 'saving'} onClick={submit} data-testid="lower-cap">{state === 'saving' ? 'Lowering…' : 'Lower cap'}</button>
      <span className="faint">
        {!enabled ? 'Available while the run is running.' : state === 'failed' ? `The server refused it; the cap stays at ${fmtInt(cap)}.` : state === 'done' ? 'Cap lowered.' : `Not below what’s spent (${fmtCredits(spent)}).`}
      </span>
    </div>
  );
}

/** The top bar's ledger total opens this compact drawer with the same view. */
export function LedgerDrawer() {
  const open = useShell((s) => s.ledgerOpen);
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Cost ledger" className="lg-drawer">
      <div className="lg-drawer-h"><h2>Ledger</h2><button className="btn sm" onClick={closeLedger}>Close</button></div>
      <LedgerTab />
    </div>
  );
}
