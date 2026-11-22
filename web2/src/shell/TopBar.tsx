import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { navigate, useRoute } from '../data/router.ts';
import { useSourcesVersion } from '../data/query.ts';
import { runStore, useRunSel } from '../data/store.ts';
import { Count } from '../lib/motion.ts';
import { fmtClock, fmtCredits, fmtInt, fmtUsd } from '../lib/format.ts';
import { openLedger } from './ui.ts';

export function TopBar() {
  const route = useRoute();
  const persona = route.page === 'candidate' ? 'candidate' : 'company';
  return (
    <header className="bar" data-testid="topbar">
      <a className="mark" href="/candidate" onClick={(e) => { e.preventDefault(); navigate({ page: 'candidate', sub: 'dashboard' }); }}>
        <span className="mark-tile" aria-hidden />
        <span className="mark-word">DOMINO</span>
        <span className="mark-sub">Search Desk</span>
      </a>
      <div className="persona" role="group" aria-label="View as">
        <button aria-pressed={persona === 'candidate'} data-testid="persona-candidate"
          onClick={() => navigate({ page: 'candidate', sub: 'dashboard' })}>Candidate</button>
        <button aria-pressed={persona === 'company'} data-testid="persona-company"
          onClick={() => navigate(route.page === 'company' ? route : { page: 'companies' })}>Company</button>
      </div>
      <div className="bar-spacer" />
      <DataPill />
      <CreditMeter />
      <TimeMeter />
      <LedgerTotal />
    </header>
  );
}

/** One truthful data-source state: where the numbers on screen actually came from. */
function DataPill() {
  const mode = useRunSel((v) => v.mode);
  const health = useRunSel((v) => v.health);
  const connected = useRunSel((v) => v.connected);
  const err = useRunSel((v) => v.error);
  const ledger = useRunSel((v) => v.ui.snap.ledger);
  const fallbacks = useRunSel((v) => v.ui.fallbacks);
  const deskSources = useSourcesVersion();
  const cached = ledger.filter((l) => l.status === 'cache_hit' || l.mode === 'cache').length + fallbacks;
  const fixtures = deskSources.filter((s) => s === 'fixture').length;

  let cls = 'live';
  let text = 'Live Crustdata';
  let title = 'Every number on screen came from a live Crustdata call made by this run.';
  if (mode === 'sample') { cls = 'sample'; text = 'Recorded run, 22 Nov'; title = 'Playing docs/sample-run-events.json: a real run on live Crustdata data, recorded 22 Nov 2026. Nothing here is live.'; }
  else if (mode === 'mock') { cls = 'mock'; text = 'Mock data, synthetic'; title = 'Synthetic events from the in-browser mock. No real company data.'; }
  else if (err || !health) { cls = 'down'; text = 'Server offline'; title = err ?? 'Waiting for /api/health'; }
  else if (!connected) { cls = 'down'; text = 'Reconnecting'; title = 'The event stream dropped; reconnecting from the last event.'; }
  else if (fixtures) { cls = 'fixture'; text = cached ? `Live Crustdata, ${cached} cached, some fixture` : 'Live run, desk on fixtures'; title = `${fixtures} desk panels use labelled fixtures until their API lands. Run events are live.`; }
  else if (cached) { cls = 'cache'; text = `Live Crustdata, ${fmtInt(cached)} cached ${cached === 1 ? 'call' : 'calls'}`; title = 'Some calls reused a cached live response (shown per call in the ledger).'; }
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
    <div className={`meter ${tone}`} data-testid="credit-meter" title={editable ? 'Drag the handle left to lower the credit cap for this run' : 'Crustdata credits used against this run’s cap'}>
      <div className="meter-top"><span>Credits</span><span><Count value={used} format={fmtCredits} /> of <b data-num>{fmtInt(cap)}</b></span></div>
      <div className="meter-track" ref={track}>
        <div className="meter-fill" style={{ transform: `scaleX(${frac})` }} />
        <button className="meter-cap" aria-label={`Credit cap ${fmtInt(cap)}. Use arrow keys to lower it.`} disabled={!editable}
          style={{ left: `${(cap / scale) * 100}%` }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' && editable) void runStore.setLimits({ maxCredits: Math.max(Math.ceil(used), budget.limits.maxCredits - 10) }); }} />
      </div>
    </div>
  );
}

/** Time left on the run's wall-clock cap. Ticks locally between budget updates while the run is running. */
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
      <span>{fmtInt(calls)} {calls === 1 ? 'call' : 'calls'} spent</span>
      <b data-num>{fmtCredits(used.credits)} credits + {fmtUsd(used.modelUsd)}</b>
    </button>
  );
}
