import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Evidence, RunLimits } from '../../shared/types.ts';
import { pickBackend } from './api.ts';
import type { Backend, StartRequest } from './api.ts';
import type { Selection } from './centrepiece/contract.ts';
import { pickCentrepiece } from './centrepiece/registry.ts';
import { RequestBar, StatusLine } from './components/Header.tsx';
import { Landing, Reel } from './components/Shell.tsx';
import { Timeline } from './components/Timeline.tsx';
import { EvidenceDrawer } from './components/Evidence.tsx';
import { TargetsStrip } from './components/Targets.tsx';
import { DraftsTab, pendingApprovals } from './components/Drafts.tsx';
import { ReplayTab } from './components/Replay.tsx';
import { EntitiesTab, LedgerTab } from './components/LedgerEntities.tsx';
import { AskCard } from './components/AskCard.tsx';
import { MAIN_REQUEST, MESSY_REQUEST, REPLAY_REQUEST } from './mock/events.ts';
import { useReducedMotion, useRun, useSize } from './useRun.ts';

type Tab = 'targets' | 'log' | 'drafts' | 'replay' | 'ledger' | 'entities';

export function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  useEffect(() => { pickBackend().then(setBackend); }, []);
  const { state, dispatch, runId, connected, error, setError, start, attach } = useRun(backend);
  const snap = state.snap;
  const centre = useMemo(() => pickCentrepiece(), []);
  const reducedMotion = useReducedMotion();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hiringFilterView, setHiringFilterView] = useState(false);
  const [replayToken, setReplayToken] = useState(0);
  // ?tab=drafts|replay|ledger|entities opens a tab on load; ?tab=none keeps the dock collapsed (handy for screenshots).
  const tabParam = new URLSearchParams(location.search).get('tab');
  const [tab, setTab] = useState<Tab | null>(tabParam && tabParam !== 'none' ? (tabParam as Tab) : null);
  const autoTabs = tabParam === null;
  const [draftCompany, setDraftCompany] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [slotRef, slot] = useSize<HTMLElement>();
  const [requestText, setRequestText] = useState('');
  const [editing, setEditing] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  // First load: reattach to ?run=ID, else the newest run; in mock mode, start the recorded run.
  useEffect(() => {
    if (!backend) return;
    const params = new URLSearchParams(location.search);
    const id = params.get('run');
    if (backend.mock) {
      if (params.get('idle') === '1') return;
      const sc = params.get('scenario');
      const text = sc === 'replay' ? REPLAY_REQUEST : sc === 'ask' ? MESSY_REQUEST : MAIN_REQUEST;
      setRequestText(text);
      start({ request: text, chaos: { timeoutOnce: ['job_search'], nonsenseOnce: ['company_growth'] } });
      return;
    }
    if (id) { attach(id); return; }
    fetch('/api/runs').then((r) => (r.ok ? r.json() : [])).then((runs: { id: string; request: string }[]) => {
      if (runs[0]) { setRequestText(runs[0].request); attach(runs[0].id); }
    }).catch(() => {});
  }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (snap.request) setRequestText(snap.request); }, [snap.request]);

  // Open the drafts tab when approvals arrive, the replay tab when a replay is scored.
  const pending = pendingApprovals(snap);
  useEffect(() => { if (autoTabs && snap.status === 'awaiting_approval' && tab === null) setTab('drafts'); }, [snap.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoTabs && snap.replay) setTab('replay'); }, [!!snap.replay]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }, [setError]);

  const onRun = (req: StartRequest) => {
    setSelection(null); setTab(null); setDraftCompany(null); setHiringFilterView(false); setEditing(false); setEvidenceOpen(false);
    act('run', () => start(req));
  };
  const onRecheck = async (ev: Evidence) => {
    if (!backend) return;
    try {
      const fresh = await backend.recheck(ev.id, ev);
      dispatch({ type: 'evidence', evidence: fresh });
    } catch (e) { setError(`Re-check failed for ${ev.id}: ${(e as Error).message}`); }
  };
  const onDecide = (id: string, d: 'approve' | 'reject') => backend && act(id, () => backend.decide(id, d));
  const onLower = (l: Partial<RunLimits>) => backend && runId && act('limits', () => backend.setLimits(runId, l));

  const running = !!runId && (snap.status === 'running' || snap.status === 'queued');
  const ask = snap.status === 'awaiting_input' ? snap.asks.find((a) => !a.answer) : undefined;
  const hasRun = !!runId;
  const Centre = centre.Component;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'targets', label: `Ranked targets${snap.targets.length ? ` (${snap.targets.length})` : ''}` },
    { id: 'log', label: 'Run log' },
    { id: 'drafts', label: pending ? `Drafts and approvals (${pending})` : `Drafts and approvals${snap.drafts.length ? ` (${snap.drafts.length})` : ''}` },
    { id: 'replay', label: 'Replay score' },
    { id: 'ledger', label: `Cost ledger${snap.ledger.length ? ` (${snap.ledger.length})` : ''}` },
    { id: 'entities', label: `Entity decisions${snap.merges.length + snap.keptApart.length ? ` (${snap.merges.length + snap.keptApart.length})` : ''}` },
  ];

  const selectFromCentre = (s: Selection | null) => {
    setSelection(s);
    if (s && (s.kind === 'node' || s.kind === 'target') && snap.drafts.some((d) => d.companyId === s.id)) setDraftCompany(s.id);
  };

  const kill = () => backend && runId && act('kill', () => backend.kill(runId));
  const resume = () => backend && runId && act('resume', () => backend.resume(runId));
  const drawerOpen = !!selection || evidenceOpen;
  const requestBar = <RequestBar initial={requestText} busy={busy === 'run'} onRun={onRun} />;
  const statusLine = (
    <StatusLine snap={snap} mock={!!backend?.mock} connected={connected} hasRun={hasRun} fallbacks={state.fallbacks} health={backend?.health ?? null} onLower={onLower} />
  );
  const errorBanner = error && (
    <div className="error" role="alert">
      <span>{error}</span>
      <button type="button" className="btn btn-quiet btn-xs" onClick={() => setError(null)}>Dismiss</button>
    </div>
  );

  // Before any run: a title card with the request box. After Run: the theatre takes the screen.
  if (!hasRun) {
    return (
      <div className="app app-landing">
        {errorBanner}
        <Landing requestBar={requestBar} source={statusLine} />
      </div>
    );
  }

  return (
    <div className={`app app-run${tab ? ' has-tab' : ''}${drawerOpen ? ' has-drawer' : ''}`}>
      <header className="bar">
        <span className="wordmark" aria-label="DOMINO">DOMINO</span>
        <div className={`bar-request${editing ? ' is-editing' : ''}`}>
          {editing ? requestBar : (
            <button type="button" className="bar-request-line" onClick={() => setEditing(true)} title="Edit the request or start a new run">
              <span className="bar-request-text">{snap.request || requestText}</span>
              <span className="bar-request-edit">New request</span>
            </button>
          )}
        </div>
        {statusLine}
      </header>
      {errorBanner}

      <main className="stage film" ref={slotRef}>
        {ask && backend && runId && (
          <AskCard ask={ask} onAnswer={(a) => act('ask', () => backend.answer(runId, ask.id, a))} busy={busy === 'ask'} />
        )}
        {slot.width > 0 && (
          <Centre
            snapshot={snap} events={state.events} running={running} selection={selection} onSelect={selectFromCentre}
            hiringFilterView={hiringFilterView} reducedMotion={reducedMotion} width={slot.width} height={slot.height}
            replayToken={replayToken}
          />
        )}
        <div className="stage-tools">
          <h2 className="sr-only">Cascade</h2>
          <label className="toggle">
            <input type="checkbox" checked={hiringFilterView} onChange={(e) => setHiringFilterView(e.target.checked)} disabled={!snap.targets.length} />
            <span className="toggle-track" aria-hidden="true" />
            Hiring-filter view
          </label>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!snap.graph.edges.length} onClick={() => setReplayToken((t) => t + 1)}>Replay cascade</button>
          <button type="button" className={`btn btn-quiet btn-sm${drawerOpen ? ' is-on' : ''}`} aria-expanded={drawerOpen}
            onClick={() => { if (drawerOpen) { setSelection(null); setEvidenceOpen(false); } else setEvidenceOpen(true); }}>
            Evidence{snap.evidence.length ? ` (${snap.evidence.length})` : ''}
          </button>
        </div>
      </main>

      {drawerOpen && (
        <aside className="drawer-wrap" aria-label="Evidence drawer">
          <EvidenceDrawer snap={snap} selection={selection} hoverEvidence={hover} onRecheck={onRecheck} onSelect={setSelection} />
          <button type="button" className="btn btn-quiet btn-xs drawer-close" onClick={() => { setSelection(null); setEvidenceOpen(false); }}>Close</button>
        </aside>
      )}

      <Reel state={state} busy={busy} onKill={kill} onResume={resume} onOpenLog={() => setTab('log')} />

      <section className="dock" aria-label="Run details">
        <div className="dock-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`dock-tab${tab === t.id ? ' is-on' : ''}${t.id === 'drafts' && pending ? ' has-pending' : ''}`}
              onClick={() => setTab((cur) => (cur === t.id ? null : t.id))}>{t.label}</button>
          ))}
          {tab && <button type="button" className="btn btn-quiet btn-xs dock-close" onClick={() => setTab(null)}>Collapse</button>}
        </div>
        {tab && (
          <div className="dock-panel m-print" role="tabpanel">
            {tab === 'targets' && <TargetsStrip snap={snap} selection={selection} hiringFilterView={hiringFilterView} onSelect={(s) => selectFromCentre(s)} />}
            {tab === 'log' && <Timeline state={state} hasRun={hasRun} busy={busy} onKill={kill} onResume={resume} />}
            {tab === 'drafts' && (
              <DraftsTab state={state} selectedCompany={draftCompany} busy={busy}
                onSelectCompany={(id) => { setDraftCompany(id); setSelection({ kind: 'target', id }); }}
                onHover={setHover}
                onPickEvidence={(id) => { setHover(id); document.getElementById(`ev-${id}`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' }); }}
                onDecide={onDecide} />
            )}
            {tab === 'replay' && <ReplayTab snap={snap} outcomes={state.outcomes} reducedMotion={reducedMotion} onRunReplay={() => onRun({ request: REPLAY_REQUEST })} />}
            {tab === 'ledger' && <LedgerTab snap={snap} />}
            {tab === 'entities' && <EntitiesTab snap={snap} />}
          </div>
        )}
      </section>
    </div>
  );
}
