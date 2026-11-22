import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { navigate } from '../data/router.ts';
import { runStore, useRunSel } from '../data/store.ts';
import { Count } from '../lib/motion.ts';
import { fmtClock, fmtCredits, fmtDate, fmtInt, fmtTime, fmtUsd } from '../lib/format.ts';
import { openLedger, signOut, useShell } from './ui.ts';

export function TopBar({ minimal = false }: { minimal?: boolean }) {
  const role = useShell((s) => s.role);
  const home = () => navigate(role === 'company' ? { page: 'companies' } : role === 'candidate' ? { page: 'candidate', sub: 'dashboard' } : { page: 'login' });
  return (
    <header className="bar" data-testid="topbar">
      <a className="mark" href="/" onClick={(e) => { e.preventDefault(); home(); }}>
        <span className="mark-tile" aria-hidden />
        <span className="mark-word">DOMINO</span>
      </a>
      <div className="bar-spacer" />
      {!minimal && role === 'company' && <><DataPill /><CreditMeter /><TimeMeter /><LedgerTotal /></>}
      {!minimal && role === 'candidate' && <DataPill />}
      {!minimal && <Account />}
    </header>
  );
}

/** Signed-in identity and the only way to change role: sign out. */
function Account() {
  const s = useShell((x) => x);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  if (!s.role) return null;
  const who = s.role === 'company' ? s.companyName ?? 'Company' : s.candidateLabel ?? 'Candidate';
  const initial = who.trim()[0]?.toUpperCase() ?? '?';
  return (
    <div className="acct" ref={ref}>
      <button className="acct-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="account">
        <span className="acct-av" aria-hidden>{initial}</span>
        <span className="acct-who">{who}</span>
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-line">Signed in as <b>{who}</b></div>
          <button role="menuitem" className="acct-item" data-testid="sign-out" onClick={() => { setOpen(false); signOut(); runStore.detach(); navigate({ page: 'login' }); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

/** One truthful data-source state for the page in view. */
function DataPill() {
  const mode = useRunSel((v) => v.mode);
  const health = useRunSel((v) => v.health);
  const err = useRunSel((v) => v.error);
  const page = useShell((s) => s.pageSource);
  const runMode = useRunSel((v) => (v.runId ? v.ui.snap.dataMode : null));
  const created = useRunSel((v) => (v.runId ? v.ui.snap.createdAt : null));
  const runAt = created ? `${fmtDate(created)} ${fmtTime(created)}` : null;
  let cls = 'live';
  let text = 'Live Crustdata';
  let title = 'The facts on this page came from live Crustdata calls.';
  if (mode === 'sample') { cls = 'sample'; text = 'Recorded run, 22 Nov'; title = 'A recorded run on live Crustdata data (docs/sample-run-events.json). Nothing here is live.'; }
  else if (mode === 'mock') { cls = 'mock'; text = 'Mock data'; title = 'Synthetic events from the in-browser mock. No real company data.'; }
  else if (err || !health) { cls = 'down'; text = 'Server offline'; title = err ?? 'Waiting for /api/health'; }
  else if (page === 'fixture') { cls = 'fixture'; text = 'Snapshot of today’s live scan'; title = 'This page shows fixture rows built from today’s live O1 scan (22 Nov) while its endpoint is finished.'; }
  else if (page === 'cache' || runMode === 'cache') { cls = 'cache'; text = `Cached live scan${runAt ? `, ${runAt}` : ''}`; title = 'Facts on this page came from live Crustdata responses cached at the time shown; no credits were spent re-reading them.'; }
  return <span className={`pill ${cls}`} title={title} data-testid="data-pill"><span className="dot" />{text}</span>;
}

/** Credits used against the cap. Drag the handle left to lower the cap mid-run (never below what's spent). */
function CreditMeter() {
  const budget = useRunSel((v) => v.ui.snap.budget);
  const status = useRunSel((v) => v.ui.snap.status);
  const runId = useRunSel((v) => v.runId);
  const mode = useRunSel((v) => v.mode);
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const cap = drag ?? budget.limits.maxCredits;
  const used = budget.used.credits;
  const scale = Math.max(budget.limits.maxCredits, 1);
  const frac = Math.min(1, used / scale);
  const editable = !!runId && mode !== 'sample' && (status === 'running' || status === 'queued' || status === 'awaiting_input');
  const tone = budget.exhausted === 'credits' ? 'bad' : used / Math.max(cap, 1) > 0.8 ? 'warn' : '';
  const valueAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.max(Math.ceil(used), Math.round(f * scale));
  };
  const onDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (!editable) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(valueAt(e.clientX));
  };
  const onMove = (e: RPointerEvent<HTMLButtonElement>) => { if (drag != null) setDrag(valueAt(e.clientX)); };
  const onUp = () => {
    if (drag == null) return;
    const v = drag;
    setDrag(null);
    if (v < budget.limits.maxCredits) void runStore.setLimits({ maxCredits: v });
  };
  return (
    <div className={`meter ${tone}`} data-testid="credit-meter" title={editable ? 'Drag the handle left to lower this run’s credit cap' : 'Crustdata credits used against this run’s cap'}>
      <div className="meter-top"><span>Credits</span><span><Count value={used} format={fmtCredits} /> of <b data-num>{fmtInt(cap)}</b></span></div>
      <div className="meter-track" ref={track}>
        <div className="meter-fill" style={{ transform: `scaleX(${frac})` }} />
        <button className="meter-cap" aria-label={`Credit cap ${fmtInt(cap)}. Arrow left lowers it.`} disabled={!editable}
          style={{ left: `${(cap / scale) * 100}%` }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' && editable) void runStore.setLimits({ maxCredits: Math.max(Math.ceil(used), budget.limits.maxCredits - 10) }); }} />
      </div>
    </div>
  );
}

function TimeMeter() {
  const budget = useRunSel((v) => v.ui.snap.budget);
  const status = useRunSel((v) => v.ui.snap.status);
  const running = status === 'running' || status === 'queued';
  const [extra, setExtra] = useState(0);
  const since = useRef(performance.now());
  useEffect(() => { since.current = performance.now(); setExtra(0); }, [budget.used.seconds]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setExtra((performance.now() - since.current) / 1000), 1000);
    return () => clearInterval(t);
  }, [running]);
  const used = budget.used.seconds + (running ? extra : 0);
  const max = Math.max(budget.limits.maxSeconds, 1);
  const left = Math.max(0, max - used);
  const tone = budget.exhausted === 'seconds' ? 'bad' : left / max < 0.2 ? 'warn' : '';
  return (
    <div className={`meter ${tone}`} data-testid="time-meter" title="Wall-clock cap for this run">
      <div className="meter-top"><span>Time left</span><b data-num>{fmtClock(left)}</b></div>
      <div className="meter-track"><div className="meter-fill" style={{ transform: `scaleX(${Math.min(1, used / max)})` }} /></div>
    </div>
  );
}

function LedgerTotal() {
  const used = useRunSel((v) => v.ui.snap.budget.used);
  const calls = useRunSel((v) => v.ui.snap.ledger.length);
  return (
    <button className="ledger-total" data-testid="ledger-open" onClick={openLedger} title="Open the cost ledger">
      <span>{fmtInt(calls)} paid {calls === 1 ? 'call' : 'calls'}</span>
      <b data-num>{fmtCredits(used.credits)} credits + {fmtUsd(used.modelUsd)}</b>
    </button>
  );
}
