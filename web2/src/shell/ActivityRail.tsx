// The agent's work, always visible: a plain-language "Now" line and an append-only stream of what it read.
// Smoothness: cards append at the end with stable keys and animate in once; the list is windowed to the last
// WINDOW cards; a catch-up burst lands settled; the Now line dwells ~900 ms and is keyed by its text.
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { SourceCard, SourceKind } from '../data/derive.ts';
import { runStore, useRunSel } from '../data/store.ts';
import { Count, useDwell, useEnterOnce } from '../lib/motion.ts';
import { fmtInt } from '../lib/format.ts';

const WINDOW = 60;

export function ActivityRail() {
  return (
    <aside className="rail" aria-label="Agent activity" data-testid="activity-rail">
      <RailHead />
      <RailStats />
      <Feed />
    </aside>
  );
}

function RailHead() {
  const narration = useRunSel((v) => v.feeds.narration);
  const slow = useRunSel((v) => v.feeds.slow);
  const status = useRunSel((v) => v.ui.snap.status);
  const runId = useRunSel((v) => v.runId);
  const mode = useRunSel((v) => v.mode);
  const shown = useDwell(narration, (a, b) => a?.text === b?.text, 900);
  const idle = !runId ? (mode === 'sample' ? 'Press play to watch the recorded agent run.' : 'Nothing running. Start a scan or onboard a candidate.') : status === 'queued' ? 'Starting the run' : 'Waiting for the first event';
  const tone = shown?.tone ?? 'info';
  return (
    <div className="rail-head">
      <div className="rail-title">
        <h2>Agent activity</h2>
        <RunState />
      </div>
      <p className={`now ${tone}`} aria-live="polite" data-testid="now-line">
        <NowText key={shown?.text ?? idle} text={shown?.text ?? idle} />
      </p>
      {slow && <div className="slow" data-testid="slow-state">{slow.text}</div>}
    </div>
  );
}

function NowText({ text }: { text: string }) {
  const ref = useEnterOnce<HTMLSpanElement>(false, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 260);
  return <span ref={ref} className="now-line"><span className="lead">Now:</span>{text}</span>;
}

const STATUS_TEXT: Record<string, string> = {
  queued: 'Starting', running: 'Running', awaiting_input: 'Needs your answer', awaiting_approval: 'Waiting for approval',
  completed: 'Finished', failed: 'Failed', crashed: 'Stopped', budget_exhausted: 'Cap reached',
};

function RunState() {
  const status = useRunSel((v) => v.ui.snap.status);
  const runId = useRunSel((v) => v.runId);
  const mode = useRunSel((v) => v.mode);
  const playing = useRunSel((v) => v.playing);
  const pending = useRunSel((v) => v.pending);
  if (mode === 'sample') {
    return playing
      ? <button className="btn small" onClick={() => runStore.pause()} data-testid="sample-pause">Pause</button>
      : <button className="btn small primary" onClick={() => { if (!runId || !pending) void runStore.loadSample().then(() => runStore.play()); else runStore.play(); }} data-testid="sample-play">{runId && pending ? 'Resume' : 'Play recorded run'}</button>;
  }
  if (!runId) return null;
  const tone = status === 'failed' || status === 'crashed' ? 'bad' : status === 'awaiting_approval' || status === 'budget_exhausted' ? 'warn' : status === 'completed' ? 'ok' : 'live';
  return <span className={`tag ${tone}`}>{STATUS_TEXT[status] ?? status}</span>;
}

function RailStats() {
  const reads = useRunSel((v) => v.feeds.reads);
  const cards = useRunSel((v) => v.feeds.sources.length);
  const calls = useRunSel((v) => v.ui.snap.ledger.length);
  const total = Object.values(reads.byEndpoint).reduce((a, b) => a + b, 0);
  return (
    <div className="rail-stats">
      <span><b><Count value={total || cards} format={fmtInt} /></b> records read</span>
      <span><b><Count value={calls} format={fmtInt} /></b> paid calls</span>
    </div>
  );
}

function Feed() {
  const sources = useRunSel((v) => v.feeds.sources);
  const catchingUp = useRunSel((v) => v.catchingUp);
  const runId = useRunSel((v) => v.runId);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = sources.length > WINDOW ? sources.slice(sources.length - WINDOW) : sources;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [sources.length]);

  return (
    <div className="feed" ref={box} data-testid="feed">
      {!shown.length && (
        <div className="feed-empty">
          {runId ? 'The first sources appear here as the agent reads them: job moves, company records, job posts and news, each with its date.' : 'When a scan or enrich runs, every record the agent reads lands here with its date and source.'}
        </div>
      )}
      {shown.map((c) => <Card key={c.key} card={c} settled={catchingUp} />)}
    </div>
  );
}

const KIND_LABEL: Record<SourceKind, string> = {
  job_move: 'Job move', company: 'Company record', job_post: 'Job post', news: 'News', funding: 'Funding', decider: 'Person record',
};

const Card = memo(function Card({ card, settled }: { card: SourceCard; settled: boolean }) {
  const ref = useEnterOnce<HTMLDivElement>(settled);
  return (
    <div ref={ref} className={`src${card.matched ? '' : ' dim'}`} data-kind={card.kind}>
      <span className="src-icon" aria-label={KIND_LABEL[card.kind]} title={KIND_LABEL[card.kind]}><KindIcon kind={card.kind} /></span>
      <span className="src-title">{card.title}</span>
      <span className="src-meta">
        <span>{card.dateLabel}</span>
        {card.company && <span>{card.company}</span>}
        {card.domain && <span>{card.domain}</span>}
        <span className="call">Call: {card.callMode === 'cache' ? 'cached' : card.callMode}</span>
      </span>
      {card.signal && <span className="src-signal">{card.signal}</span>}
    </div>
  );
});

export function KindIcon({ kind }: { kind: SourceKind }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'job_move':
      return <svg viewBox="0 0 16 16"><circle cx="4" cy="5" r="2" {...p} /><path d="M1.5 12c.4-2 1.4-3 2.5-3s2.1 1 2.5 3M9 8h5.5M12 5.5 14.5 8 12 10.5" {...p} /></svg>;
    case 'company':
      return <svg viewBox="0 0 16 16"><path d="M2.5 14V3.5l5-1.5v12M7.5 6h6v8M4.5 6h1M4.5 9h1M10 9h1M10 11.5h1M1.5 14h13" {...p} /></svg>;
    case 'job_post':
      return <svg viewBox="0 0 16 16"><rect x="2" y="4.5" width="12" height="9" rx="1.5" {...p} /><path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M2 8.5h12" {...p} /></svg>;
    case 'funding':
      return <svg viewBox="0 0 16 16"><path d="M2 12.5 6 8.5l3 2.5 5-6M10.5 5H14v3.5" {...p} /></svg>;
    case 'decider':
      return <svg viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.5" {...p} /><path d="M3 14c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3" {...p} /></svg>;
    default:
      return <svg viewBox="0 0 16 16"><path d="M3 2.5h7.5L13 5v8.5H3zM5.5 6.5h5M5.5 9h5M5.5 11.5h3" {...p} /></svg>;
  }
}
