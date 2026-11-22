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

  return (
    <div className="ledger">
      <div className="lg-run">
        <span className="st plain mono" title={snap.id}>{snap.id.slice(0, 12)}</span>
        <span className="lg-req">{requestLabel(snap.request)}</span>
        <span className={`st ${snap.status === 'budget_exhausted' ? 'held' : 'plain'}`}>
          {snap.status === 'budget_exhausted' ? `Stopped at the ${CAP_NAME[b.exhausted ?? 'credits']}` : snap.status.replace(/_/g, ' ')}
        </span>
        {readOnly && <span className="faint">Past run, read-only</span>}
      </div>

      <section className="panel lg-strip" aria-label="Spend against the caps">
        <p className="lg-line" data-testid="cap-line">
          <span>Used <b><Count value={credits} format={fmtCredits} /></b> credits</span>
          <span className="sep">·</span>
          <span>Reserved <b>{fmtCredits(reserved.credits)}</b>
            {reserved.modelUsd > 0 && <> + <b>{fmtUsd(reserved.modelUsd)}</b> model</>}
            {(reserved.credits > 0 || reserved.modelUsd > 0) && last ? <span className="faint"> ({last} in flight)</span> : null}</span>
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
            <div className="faint">Cap credits {fmtInt(b.limits.maxCredits)} · would have cost ≈ {fmtCredits(r.credits)} credits · not dispatched</div>
          </div>
          <span className="st held">Not dispatched</span>
        </div>
      )) : (
        <div className={`blocked${b.exhausted ? '' : ' quiet'}`} data-testid="blocked-call">
          <div>
            <b>{b.exhausted ? `This run stopped at the ${CAP_NAME[b.exhausted]}` : 'No call was blocked in this run'}</b>
            <div className="faint">A call that would cross a cap is refused before it spends and shows here as “Not dispatched”.
              {b.exhausted === 'seconds' ? ` It ran ${fmtInt(b.used.seconds)} s of ${fmtInt(b.limits.maxSeconds)} s; nothing after that was sent.` : ''}</div>
          </div>
          <span className={`st ${b.exhausted ? 'held' : 'plain'}`}>{b.exhausted ? 'Cap reached' : 'Within caps'}</span>
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
          <h2>{plural(rows.length, 'call')} in this run</h2>
          {!paid && rows.length > 0 && <span className="lg-note" data-testid="cached-note">This scan reused cached live responses: 0 new credits</span>}
        </header>
        {rows.length === 0 ? (
          <p className="pad faint">This run made no paid calls. Rows appear here as each call returns, with its credits and cost.</p>
        ) : (
          <table className="t lg-table">
            <thead><tr><th>Time</th><th>Step</th><th>Endpoint</th><th>Mode</th><th>Status</th><th className="num">Credits</th><th className="num">Tokens</th><th className="num">USD</th><th className="num">Latency</th></tr></thead>
            <tbody>{rows.map((r) => <Row key={r.id} r={r} />)}</tbody>
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
        )}
      </section>
    </div>
  );
}

function Row({ r }: { r: LedgerEntry }) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (!reducedMotion()) ref.current?.animate(ENTER, { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' }); }, []);
  const bad = r.status !== 'ok' && r.status !== 'cache_hit';
  return (
    <tr ref={ref} data-testid="ledger-row" className={r.status === 'budget_blocked' ? 'blocked-row' : undefined}>
      <td className="mono">{fmtTime(r.ts)}</td>
      <td className="lg-step" title={stepName(r)}>{stepName(r)}</td>
      <td className="mono" title={ENDPOINT_NOUN[r.endpoint] ?? r.endpoint}>{r.endpoint}</td>
      <td>{r.injected ? <span className="st held">Injected fault</span> : modeLabel(r)}</td>
      <td className={bad ? 'lg-bad' : undefined}>{STATUS[r.status]}{r.attempt > 1 ? ` · try ${r.attempt}` : ''}</td>
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
      <div className="lg-cap-n">{hit ? 'Cap reached: the next call was refused' : `${fmt(Math.max(0, cap - used - reserved))} left`}{reserved > 0 ? ` · ${fmt(reserved)} reserved` : ''}</div>
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
