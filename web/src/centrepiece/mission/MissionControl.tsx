// DOMINO mission control: watch the agent work. One view, driven only by the RunSnapshot and the event log.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StepName } from '../../../../shared/types.ts';
import { STEP_ORDER } from '../../../../shared/types.ts';
import type { CentrepieceProps } from '../contract.ts';
import { ChainStage, LooseClaim } from './Chain.tsx';
import { Desk, SourceList } from './Desk.tsx';
import { Gate } from './Gate.tsx';
import { CallStream, Gauge, StepRail } from './Instruments.tsx';
import { Scoreboard } from './Scoreboard.tsx';
import {
  STEP_SHORT, chainRows, sourceKind, companyName, day, deskView, engineView, gateView, looseUnverifiable, narrate, replayView, streamRows,
} from './model.ts';
import './mission.css';

/** Optional hooks a host can pass so the instruments become controls. Without them the view is read-only. */
export interface MissionControls {
  kill?: () => void;
  resume?: () => void;
  setCreditCap?: (credits: number) => void;
  approve?: (approvalId: string) => void;
  autoResume?: boolean;        // the host restarts the engine itself after a kill
}

const MODE_LABEL = { live: 'Live Crustdata', cache: 'Cached live responses', fixture: 'Fixture · synthetic data' } as const;

const STATUS_LINE: Record<string, string> = {
  queued: 'Queued', running: 'Working', awaiting_input: 'Waiting for one answer', awaiting_approval: 'Your turn',
  completed: 'Finished', failed: 'Failed', crashed: 'Engine down', budget_exhausted: 'Stopped at the credit cap',
};

export function MissionControl(props: CentrepieceProps & { controls?: MissionControls }) {
  const { snapshot: snap, events, width, height, reducedMotion, selection, onSelect, hiringFilterView, replayToken, controls } = props;
  const compact = width < 1100;
  const base = compact ? Math.max(10.5, Math.min(width / 62, height / 43)) : Math.max(13, Math.min(width / 94, height / 58, 18));

  // Anything already in the log when we mount is drawn settled; only new events animate. Replay re-arms it.
  const settled = useRef<number>(events.at(-1)?.seq ?? 0);
  const [stageKey, setStageKey] = useState(0);
  const firstToken = useRef(replayToken);
  useEffect(() => {
    if (replayToken === firstToken.current) return;
    settled.current = 0;
    setStageKey((k) => k + 1);
  }, [replayToken]);
  const settledSeq = settled.current;

  const rows = useMemo(() => chainRows(snap, events), [snap, events]);
  const loose = useMemo(() => looseUnverifiable(events, rows), [events, rows]);
  const stream = useMemo(() => streamRows(events, snap), [events, snap]);
  const engine = useMemo(() => engineView(events), [events]);
  const gate = useMemo(() => gateView(snap, events), [snap, events]);
  const replay = useMemo(() => replayView(snap, events), [snap, events]);
  const desk = useMemo(() => deskView(events, snap), [events, snap]);
  const line = useMemo(() => narrate(events, snap), [events, snap]);

  const calls = snap.ledger.length ? snap.ledger : stream.flatMap((r) => (r.kind === 'call' ? [r.entry] : []));
  const total = { calls: calls.length, credits: calls.reduce((s, e) => s + (e.credits || 0), 0) };

  // Gauge scale only ever grows, so dragging the cap never rescales under the pointer.
  const scaleRef = useRef(0);
  scaleRef.current = Math.max(scaleRef.current, Math.ceil(Math.max(snap.budget.limits.maxCredits, snap.budget.used.credits * 1.5, 100) / 100) * 100);

  const capNote = useMemo(() => {
    let prevCap: number | null = null;
    let note: string | null = null;
    for (const { event: ev } of events) {
      if (ev.type === 'budget.update') {
        const c = ev.budget.limits.maxCredits;
        if (prevCap !== null && c < prevCap) note = `Cap lowered to ${c}. The engine re-reads it before every paid call.`;
        if (prevCap !== null && c > prevCap) note = `Cap raised to ${c}.`;
        prevCap = c;
      }
      if (ev.type === 'run.status' && ev.status === 'budget_exhausted') note = `Stopped at the cap${ev.note ? `: ${ev.note.replace(/^credit ceiling \d+ reached before /, 'before ')}` : ''}. Partial result kept.`;
      if (ev.type === 'run.status' && ev.status === 'running' && ev.note === 'Limit raised') note = 'Cap raised. Picking up where it stopped.';
    }
    return note;
  }, [events]);

  // View: the run, or the replay scoreboard once a replay has been scored.
  const [view, setView] = useState<'run' | 'replay'>(replay?.score && snap.intent?.runKind === 'replay' ? 'replay' : 'run');
  const scoredSeq = replay?.scoredSeq ?? 0;
  useEffect(() => { if (scoredSeq > settledSeq) { const t = setTimeout(() => setView('replay'), 1200); return () => clearTimeout(t); } }, [scoredSeq]);

  // Crash choreography: glitch, black, then lift on resume with a receipt of what was reused.
  const [lifted, setLifted] = useState<{ seq: number; skipped: number; from: StepName } | null>(null);
  const crashed = engine.crashed;
  const crashLive = !!crashed && crashed.seq > settledSeq;
  useEffect(() => {
    const r = engine.lastResume;
    if (!r || r.seq <= settledSeq || crashed) return;
    setLifted({ seq: r.seq, skipped: r.skipped.length, from: r.fromStep });
    const t = setTimeout(() => setLifted(null), 5200);
    return () => clearTimeout(t);
  }, [engine.lastResume?.seq, !!crashed]);

  useEffect(() => {
    if (!crashed || !controls?.autoResume || !controls.resume) return;
    const t = setTimeout(() => controls.resume?.(), 2600);
    return () => clearTimeout(t);
  }, [crashed?.seq]);

  const running = snap.steps.find((s) => s.status === 'running')?.step ?? null;
  let current: StepName | null = running;
  if (!current) for (const { event: ev } of events) if (ev.type === 'step.started') current = ev.step;
  const doneCount = snap.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const stepIdx = current ? STEP_ORDER.indexOf(current) + 1 : 0;
  const statusLine = snap.status === 'running' && current ? `${STEP_SHORT[current]}` : snap.status === 'awaiting_approval' && gate?.sent ? 'Sent once' : STATUS_LINE[snap.status] ?? snap.status;

  const isReplayRun = snap.intent?.runKind === 'replay';
  const asOf = snap.intent?.asOf ?? null;
  const nameOf = (id: string) => companyName(snap, id);
  const gateShown = view === 'run' && !!gate;
  const gatePending = gateShown && !gate?.sent;
  // At the gate, the board shows the recipient's own chain; with none, the draft's own dated sources.
  const gateRows = gate ? rows.filter((r) => r.edge.to === gate.draft.companyId || r.edge.from === gate.draft.companyId) : [];
  const gateCards = gate ? gate.draft.citations.flatMap((c) => {
    const e = gate.evidence.get(c.evidenceId);
    if (!e) return [];
    const [kind, kindLabel] = sourceKind(e.source.endpoint);
    return [{ id: e.id, seq: 0, claim: `[${c.marker}] ${e.claim}`, value: e.value == null ? null : String(e.value), endpoint: e.source.endpoint, kind, kindLabel, observedAt: e.observedAt, dated: e.verifiable && !!e.observedAt, mode: e.mode }];
  }) : [];
  const maxRows = gatePending ? (compact ? 1 : 2) : 4;
  const gateH = Math.round(height * (compact ? 0.5 : 0.44));
  const empty = rows.length === 0 && loose.length === 0;

  return (
    <div
      className={`mc${compact ? ' mc--compact' : ' mc--full'}${reducedMotion ? ' mc--still' : ''}${crashed ? ' is-down' : ''}${crashLive ? ' is-jolt' : ''}${gateShown ? ' has-gate' : ''}${gate?.sent ? ' gate-sent' : ''}`}
      style={{ width, height, fontSize: `${base}px`, ['--gate-h' as string]: `${gateH}px` } as CSSProperties}
    >
      <header className="mc-head">
        <div className="mc-head__status">
          <span className={`mc-beacon mc-beacon--${snap.status}`} aria-hidden="true" />
          <strong>{statusLine}</strong>
          {snap.status === 'running' && current && <span className="mc-head__step">step {stepIdx} of {STEP_ORDER.length}</span>}
        </div>
        {line && (
          <p key={line.seq} className={`mc-say mc-say--${line.tone}${line.seq > settledSeq ? ' is-live' : ''}`} aria-live="polite">{line.text}</p>
        )}
        {replay?.score && (
          <div className="mc-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'run'} className={view === 'run' ? 'on' : ''} onClick={() => setView('run')}>The run</button>
            <button role="tab" aria-selected={view === 'replay'} className={view === 'replay' ? 'on' : ''} onClick={() => setView('replay')}>Replay score</button>
          </div>
        )}
        <div className="mc-head__right">
          <span className={`mc-chip mc-chip--${snap.dataMode}`}>{MODE_LABEL[snap.dataMode]}</span>
          {asOf && <span className="mc-head__asof">{isReplayRun ? `Frozen at ${day(asOf, true)}` : `As of ${day(asOf, true)}`}</span>}
        </div>
      </header>

      <CallStream rows={stream} settledSeq={settledSeq} total={total} />

      <main className="mc-stage" key={stageKey}>
        {(() => {
          const ch = chapterFor(view, current, snap.status, !!crashed, !!gate?.sent, rows.length > 0, snap.dataMode);
          return (
            <div className="mc-chapter" key={ch.title}>
              {ch.n && <span className="mc-chapter__n">{ch.n}</span>}
              <span className="mc-chapter__t">{ch.title}</span>
              <span className="mc-chapter__s">{ch.sub}</span>
            </div>
          );
        })()}
        {view === 'replay' && replay ? (
          <Scoreboard view={replay} animate={scoredSeq > settledSeq || stageKey > 0} nameOf={nameOf} onSelect={onSelect} fixture={snap.dataMode === 'fixture'} reducedMotion={reducedMotion} />
        ) : (
          <>
            {rows.length === 0 && (desk.cards.length > 0 || desk.pending) && <Desk desk={desk} settledSeq={settledSeq} onSelect={onSelect} />}
            {rows.length > 0 && (
              <div className="mc-from">
                From <b>{desk.cards.length}</b> sources read and <b>{desk.signalCount}</b> signals across <b>{desk.companies.length}</b> companies, these links held up:
              </div>
            )}
            {empty && desk.cards.length === 0 && !desk.pending && (
              <div className="mc-empty">
                <Dominoes />
                <p>{snap.status === 'queued' || snap.status === 'running' ? 'Pulling dated changes. The chain builds here as each link is verified.' : 'Start a run to watch the chain build.'}</p>
              </div>
            )}
            {gatePending && gate && gateRows.length === 0 ? (
              <SourceList title={`Dated sources behind the message to ${nameOf(gate.draft.companyId)}`} cards={gateCards} onSelect={onSelect} />
            ) : (
            <ChainStage rows={gatePending ? gateRows : rows} settledSeq={settledSeq} selection={selection} onSelect={onSelect} hiringFilterView={hiringFilterView} reducedMotion={reducedMotion} maxRows={maxRows} />
            )}
            {loose.length > 0 && (
              <div className="mc-tray">
                {loose.slice(-2).map((l) => <LooseClaim key={l.seq} claim={l.claim} reason={l.reason} animate={!reducedMotion && l.seq > settledSeq} />)}
              </div>
            )}
          </>
        )}
        {lifted && (
          <div className="mc-resumed" role="status">
            <strong>Resumed from the checkpoint</strong>
            <span>{lifted.skipped} finished steps reused, not re-run · picking up at {STEP_SHORT[lifted.from]}</span>
          </div>
        )}
      </main>

      <Gauge budget={snap.budget} scaleMax={scaleRef.current} onCap={controls?.setCreditCap} note={capNote} />

      <footer className="mc-foot">
        <StepRail steps={snap.steps} current={current} crashedAt={crashed?.atStep ?? null} />
        {controls?.kill && (
          <button
            type="button"
            className="mc-kill"
            onClick={() => controls.kill?.()}
            disabled={!!crashed || !(snap.status === 'running')}
          >
            <span className="mc-kill__label">{crashed ? 'Engine down' : 'Kill engine'}</span>
            <span className="mc-kill__sub">{crashed ? (controls.autoResume ? 'restarting…' : 'resume to continue') : `SIGKILL pid ${engine.pid ?? '—'}`}</span>
          </button>
        )}
        {crashed && controls?.resume && !controls.autoResume && (
          <button type="button" className="mc-resume" onClick={() => controls.resume?.()}>Resume from checkpoint</button>
        )}
      </footer>

      {gateShown && gate && <Gate gate={gate} settledSeq={settledSeq} onApprove={controls?.approve} reducedMotion={reducedMotion} />}

      {crashed && (
        <div className={`mc-crash${crashLive && !reducedMotion ? ' is-live' : ''}`} role="alert">
          <div className="mc-crash__bars" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ ['--i' as string]: i } as CSSProperties} />)}</div>
          <div className="mc-crash__text">
            <span className="mc-crash__sig">SIGKILL · pid {crashed.pid}</span>
            <strong>The engine died during {crashed.atStep ? STEP_SHORT[crashed.atStep] : 'start-up'}.</strong>
            <span className="mc-crash__saved">{doneCount} of {STEP_ORDER.length} steps saved. Nothing will be re-run or re-sent.</span>
            {controls?.resume && !controls.autoResume ? (
              <button type="button" className="mc-crash__resume" onClick={() => controls.resume?.()}>Resume from the checkpoint</button>
            ) : (
              <span className="mc-crash__wait">{controls?.autoResume ? 'Restarting the engine…' : 'Waiting for Resume'}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Plain-language chapters so a first-time viewer always knows which part of the job this is.
function chapterFor(view: 'run' | 'replay', step: StepName | null, status: string, crashed: boolean, gateSent: boolean, hasRows: boolean, mode: string) {
  if (crashed) return { n: null, title: 'Robustness test', sub: 'The engine was killed mid-run. Watch it come back from its last checkpoint without repeating work.' };
  if (view === 'replay') return { n: 5, title: 'Were we right?', sub: 'Clock frozen at 1 Sep with no later facts. Each prediction drops when a dated event proves it.' };
  if (status === 'awaiting_approval' || step === 'approval_gate') return gateSent
    ? { n: 4, title: 'Sent once', sub: 'One approval, one message in the team test inbox. Approving again is refused by the same key.' }
    : { n: 4, title: 'Your call', sub: 'Nothing leaves until a person approves. Every claim in the message links to a dated source.' };
  if (step === 'find_deciders' || step === 'warm_paths' || step === 'draft_messages') return { n: 3, title: 'Finding who decides and writing to them', sub: 'One person per account. The message may only say what a dated source says.' };
  if (hasRows || step === 'cascade' || step === 'rank_targets') return { n: 2, title: 'Connecting the dots', sub: 'A change at one company creates a need at another. A link needs two dated sources, or it breaks.' };
  const sub = mode === 'live' ? 'Every card is a source pulled from Crustdata just now, with the date it happened.'
    : mode === 'cache' ? 'Every card is a recorded Crustdata response, with the date it happened.'
    : 'Every card is a synthetic fixture source, with the date it happened.';
  return { n: 1, title: mode === 'cache' ? 'Reading recorded Crustdata responses' : 'Reading the market', sub };
}

function Dominoes() {
  return (
    <svg className="mc-empty__art" viewBox="0 0 220 80" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} transform={`translate(${18 + i * 40} 12) rotate(${i === 0 ? -16 : 0} 12 56)`}>
          <rect width="24" height="56" rx="4" />
          <line x1="3" x2="21" y1="28" y2="28" />
        </g>
      ))}
    </svg>
  );
}
