// Run theatre: the full-screen main run view (`?view=theatre`). Same backend, same reducer and same event stream as
// the classic app (useRun + pickBackend); the mission-control centrepiece fills the screen and its instruments are
// wired to the real endpoints: kill, resume, credit cap, approve. With no server it plays the recorded mock run,
// which is labelled as fixture data because every company in it is fictional.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Selection } from '../centrepiece/contract.ts';
import { MissionControl } from '../centrepiece/mission/index.ts';
import type { MissionControls } from '../centrepiece/mission/index.ts';
import type { Backend } from '../api.ts';
import { pickBackend } from '../api.ts';
import { MAIN_REQUEST, REPLAY_REQUEST } from '../mock/events.ts';
import { useRun } from '../useRun.ts';

const BAR = 56;
const CHAOS = { timeoutOnce: ['job_search'], nonsenseOnce: ['company_growth'] };

function useViewport() {
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: innerWidth, h: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return vp;
}

export function Theatre() {
  const [backend, setBackend] = useState<Backend | null>(null);
  useEffect(() => { pickBackend().then(setBackend); }, []);
  const { state, runId, error, setError, start, attach } = useRun(backend);
  const [request, setRequest] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hiringFilterView, setHiringFilterView] = useState(false);
  const [replayToken, setReplayToken] = useState(0);
  const vp = useViewport();
  const reducedMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const run = useCallback((text: string) => {
    setSelection(null); setHiringFilterView(false); setRequest(text);
    start({ request: text, chaos: CHAOS }).catch((e: Error) => setError(e.message));
  }, [start, setError]);

  // First load: ?run=ID reattaches; otherwise the newest run (real backend) or nothing until Run is pressed.
  useEffect(() => {
    if (!backend) return;
    const params = new URLSearchParams(location.search);
    const id = params.get('run');
    if (backend.mock) {
      const sc = params.get('scenario');
      const text = sc === 'replay' ? REPLAY_REQUEST : MAIN_REQUEST;
      setRequest(text);
      if (params.get('autostart') === '1') run(text);
      return;
    }
    if (id) { attach(id); return; }
    fetch('/api/runs').then((r) => (r.ok ? r.json() : [])).then((runs: { id: string; request: string }[]) => {
      if (runs[0]) { setRequest(runs[0].request); attach(runs[0].id); } else setRequest(MAIN_REQUEST);
    }).catch(() => setRequest(MAIN_REQUEST));
  }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (state.snap.request) setRequest(state.snap.request); }, [state.snap.request]);

  const snapshot = useMemo(
    () => (backend?.mock ? { ...state.snap, dataMode: 'fixture' as const } : state.snap),
    [state.snap, backend?.mock],
  );

  const controls: MissionControls = useMemo(() => {
    if (!backend || !runId) return {};
    const guard = (p: Promise<unknown>) => { p.catch((e: Error) => setError(e.message)); };
    return {
      kill: () => guard(backend.kill(runId)),
      resume: () => guard(backend.resume(runId)),
      setCreditCap: (credits: number) => guard(backend.setLimits(runId, { maxCredits: credits })),
      approve: (approvalId: string) => guard(backend.decide(approvalId, 'approve')),
      autoResume: false,
    };
  }, [backend, runId, setError]);

  const busy = snapshot.status === 'running' || snapshot.status === 'queued';

  return (
    <div className="th">
      <style>{CSS}</style>
      <form className="th-bar" style={{ height: BAR }} onSubmit={(e) => { e.preventDefault(); if (request.trim()) run(request.trim()); }}>
        <span className="th-mark">DOMINO</span>
        <input className="th-req" value={request} onChange={(e) => setRequest(e.target.value)} aria-label="Request" placeholder="What do you sell, and who should it find?" />
        <button type="submit" className="th-go" disabled={!backend || busy || !request.trim()}>Run</button>
        <button type="button" className={`th-btn${hiringFilterView ? ' on' : ''}`} disabled={!snapshot.targets.length} onClick={() => setHiringFilterView((v) => !v)}>Hiring-filter view</button>
        <button type="button" className="th-btn" disabled={!backend || busy} onClick={() => run(REPLAY_REQUEST)}>Replay 1 Sep → 22 Nov</button>
        <button type="button" className="th-btn" disabled={!snapshot.graph.edges.length} onClick={() => setReplayToken((t) => t + 1)}>Replay cascade</button>
        <a className="th-link" href={`?${new URLSearchParams({ ...(runId ? { run: runId } : {}) })}`}>Classic view</a>
      </form>
      {error && <p className="th-err" role="alert">{error}</p>}
      <MissionControl
        key={runId ?? 'idle'}
        snapshot={snapshot}
        events={state.events}
        running={busy}
        selection={selection}
        onSelect={setSelection}
        hiringFilterView={hiringFilterView}
        reducedMotion={reducedMotion}
        width={vp.w}
        height={vp.h - BAR}
        replayToken={replayToken}
        controls={controls}
      />
    </div>
  );
}

const CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; background: #0a1f1c; }
.th { font-family: 'MC Text', system-ui, sans-serif; color: #dfe9e3; }
.th-bar { display: flex; align-items: center; gap: 12px; padding: 0 16px; background: #0a1f1c; border-bottom: 1px solid #24504a; box-sizing: border-box; }
.th-mark { font-family: 'MC Display', sans-serif; font-weight: 900; font-size: 24px; letter-spacing: 0.04em; color: #efe8d7; }
.th-req { flex: 1; min-width: 0; font: inherit; font-size: 14px; color: #efe8d7; background: #0f2b27; border: 1px solid #24504a; border-radius: 8px; padding: 9px 12px; }
.th-req:focus-visible, .th-go:focus-visible, .th-btn:focus-visible, .th-link:focus-visible { outline: 2px solid #e2ab3f; outline-offset: 2px; }
.th-go, .th-btn { font: inherit; font-size: 14px; border-radius: 8px; padding: 8px 14px; cursor: pointer; white-space: nowrap; }
.th-go { background: #efe8d7; color: #1b1714; border: 0; font-weight: 700; padding: 9px 22px; }
.th-btn { background: none; color: #dfe9e3; border: 1px solid #24504a; }
.th-btn.on { background: #e2ab3f; color: #1b1714; border-color: #e2ab3f; }
.th-go:disabled, .th-btn:disabled { opacity: 0.45; cursor: default; }
.th-link { color: #8eafa5; font-size: 13px; white-space: nowrap; }
.th-err { position: fixed; z-index: 50; left: 50%; top: 64px; transform: translateX(-50%); margin: 0; padding: 8px 14px; border-radius: 8px; background: #e5553c; color: #fff; font-size: 14px; }
`;
