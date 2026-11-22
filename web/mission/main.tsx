// Full-screen harness for the mission-control centrepiece. It plays the web app's recorded mock run (fictional
// companies, labelled as a fixture) through the same reducer the app uses, and wires the instruments to the mock
// engine: kill + resume, credit cap, approvals. In the app, the real server drives the same component.
//
// URL params: ?run=live|replay  ?speed=1  ?slot=1 (render at the 780x540 slot size)  ?autoplay=1 (hands-free demo)
import { StrictMode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Selection } from '../src/centrepiece/contract.ts';
import { MissionControl } from '../src/centrepiece/mission/index.ts';
import type { MissionControls } from '../src/centrepiece/mission/index.ts';
import { MAIN_REQUEST, REPLAY_REQUEST, buildScenario } from '../src/mock/events.ts';
import { emptySnapshot, initialState, uiReducer } from '../src/state.ts';
import { MockRun } from '../src/mock/player.ts';

const params = new URLSearchParams(location.search);
const SPEED = Number(params.get('speed') ?? '1') || 1;
const SLOT = params.has('slot');
const AUTOPLAY = params.has('autoplay');
const HEADER = 52;

type Kind = 'live' | 'replay';

function useViewport() {
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: innerWidth, h: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return vp;
}

function Harness() {
  const [kind, setKind] = useState<Kind>((params.get('run') as Kind) ?? 'live');
  const [runNo, setRunNo] = useState(0);
  const runId = `run_mission_${kind}_${runNo}`;
  const request = kind === 'replay' ? REPLAY_REQUEST : MAIN_REQUEST;
  const mock = useMemo(() => new MockRun(buildScenario(kind, request, runId), { speed: SPEED, autoCrash: false, instant: false }), [runId]);
  const [state, dispatch] = useReducer(uiReducer, undefined, () => initialState(emptySnapshot(runId, request)));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hiringFilterView, setHiringFilterView] = useState(false);
  const [replayToken, setReplayToken] = useState(0);
  const [started, setStarted] = useState(false);
  const vp = useViewport();

  useEffect(() => {
    dispatch({ type: 'reset', snap: emptySnapshot(runId, request) });
    const off = mock.subscribe(0, (events) => dispatch({ type: 'events', events }));
    return () => { off(); };
  }, [mock]);

  const start = useCallback(() => { if (!started) { setStarted(true); mock.start(); } }, [mock, started]);
  const newRun = (k: Kind) => { setKind(k); setRunNo((n) => n + 1); setStarted(false); setSelection(null); };

  // The mock reports dataMode 'live'; every company in it is fictional, so label it what it is.
  const snapshot = useMemo(() => ({ ...state.snap, dataMode: 'fixture' as const }), [state.snap]);

  const controls: MissionControls = useMemo(() => ({
    kill: () => mock.kill(),
    resume: () => mock.resume(),
    autoResume: true,
    setCreditCap: (credits: number) => mock.setLimits({ maxCredits: credits }),
    approve: (id: string) => mock.decide(id, 'approve'),
  }), [mock]);

  // Hands-free run for recording: start, kill mid-cascade, approve, approve again, then the replay.
  const auto = useRef({ killed: false, approved: 0 });
  const events = useMemo(() => mock.events.slice(), [state.lastSeq, mock]);
  useEffect(() => {
    if (!AUTOPLAY || started) return;
    const t = setTimeout(start, 700 / SPEED);
    return () => clearTimeout(t);
  }, [mock, started]);
  useEffect(() => {
    if (!AUTOPLAY) return;
    const a = auto.current;
    const snap = state.snap;
    const cascadeRunning = snap.steps.find((x) => x.step === 'cascade')?.status === 'running';
    if (kind === 'live' && cascadeRunning && !a.killed) {
      a.killed = true;
      const t = setTimeout(() => mock.kill(), 900 / SPEED);
      return () => clearTimeout(t);
    }
    const msg = snap.approvals.find((x) => x.kind === 'send_message' && x.companyId === snap.targets.find((t) => t.rank === 1)?.companyId);
    if (kind === 'live' && snap.status === 'awaiting_approval' && msg && a.approved === 0) {
      a.approved = 1;
      const t1 = setTimeout(() => mock.decide(msg.id, 'approve'), 4200 / SPEED);
      const t2 = setTimeout(() => mock.decide(msg.id, 'approve'), 9000 / SPEED);
      const t3 = setTimeout(() => newRun('replay'), 14000 / SPEED);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); a.approved = 0; };
    }
  }, [state.snap, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); start(); }
      if (e.key === 'k') mock.kill();
      if (e.key === 'h') setHiringFilterView((v) => !v);
      if (e.key === 'r') newRun('replay');
      if (e.key === 'l') newRun('live');
      if (e.key === 'p') setReplayToken((t) => t + 1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [mock, start]);

  const w = SLOT ? 780 : vp.w;
  const h = SLOT ? 540 : vp.h - HEADER;

  return (
    <div className="hx">
      <style>{HARNESS_CSS}</style>
      <header className="hx-bar" style={{ height: HEADER }}>
        <span className="hx-mark">DOMINO</span>
        <span className="hx-req">{request}</span>
        {!started ? (
          <button type="button" className="hx-go" onClick={start}>Run</button>
        ) : (
          <>
            <button type="button" className={`hx-btn${hiringFilterView ? ' on' : ''}`} onClick={() => setHiringFilterView((v) => !v)}>Hiring-filter view</button>
            {kind === 'live'
              ? <button type="button" className="hx-btn" onClick={() => newRun('replay')}>Replay 1 Sep → 22 Nov</button>
              : <button type="button" className="hx-btn" onClick={() => newRun('live')}>Back to the live run</button>}
          </>
        )}
      </header>
      <div className={SLOT ? 'hx-slot' : ''} style={{ height: vp.h - HEADER }}>
        <MissionControl
          key={runId}
          snapshot={snapshot}
          events={events}
          running={snapshot.status === 'running'}
          selection={selection}
          onSelect={setSelection}
          hiringFilterView={hiringFilterView}
          reducedMotion={matchMedia('(prefers-reduced-motion: reduce)').matches}
          width={w}
          height={h}
          replayToken={replayToken}
          controls={controls}
        />
      </div>
    </div>
  );
}

const HARNESS_CSS = `
.hx { font-family: 'MC Text', system-ui, sans-serif; color: #dfe9e3; }
.hx-bar { display: flex; align-items: center; gap: 16px; padding: 0 18px; background: #0a1f1c; border-bottom: 1px solid #24504a; box-sizing: border-box; }
.hx-mark { font-family: 'MC Display', sans-serif; font-weight: 900; font-size: 24px; letter-spacing: 0.04em; color: #efe8d7; }
.hx-req { flex: 1; min-width: 0; font-size: 14px; color: #8eafa5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hx-go, .hx-btn { font: inherit; font-size: 14px; border-radius: 8px; padding: 7px 14px; cursor: pointer; }
.hx-go { background: #efe8d7; color: #1b1714; border: 0; font-weight: 700; padding: 8px 22px; }
.hx-btn { background: none; color: #dfe9e3; border: 1px solid #24504a; }
.hx-btn.on { background: #e2ab3f; color: #1b1714; border-color: #e2ab3f; }
.hx-slot { display: grid; place-items: center; background: #0a1f1c; }
`;

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
