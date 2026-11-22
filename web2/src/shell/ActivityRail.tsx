// Source activity for the run behind the page in view: a plain-language Now line and every record the run read,
// newest first, kept or discarded. Smoothness: stable keys, entrance once per card, a transform-only FLIP glide when
// a new card lands on top, a catch-up burst lands settled, and the Now line dwells ~900 ms keyed by its text.
import { memo, useRef } from 'react';
import type { SourceCard, SourceKind } from '../data/derive.ts';
import { runStore, useRunSel } from '../data/store.ts';
import { Count, useDwell, useEnterOnce, useFlip } from '../lib/motion.ts';
import { fmtInt } from '../lib/format.ts';
import { prettyText } from '../lib/text.ts';

const WINDOW = 50;

export function ActivityRail() {
  return (
    <aside className="rail" aria-label="Source activity" data-testid="activity-rail">
      <RailHead />
      <RailStats />
      <Feed />
    </aside>
  );
}

function RailHead() {
  const narration = useRunSel((v) => v.feeds.narration);
  const slow = useRunSel((v) => v.feeds.slow);
  const runId = useRunSel((v) => v.runId);
  const mode = useRunSel((v) => v.mode);
  const applied = useRunSel((v) => v.version);
  const shown = useDwell(narration, (a, b) => a?.text === b?.text, 900);
  const idle = mode === 'sample'
    ? (applied ? 'Recorded activity paused.' : 'Recorded activity. Press play to replay it.')
    : !runId ? 'No activity for this view yet.' : 'Waiting for the first read.';
  const tone = shown?.tone ?? 'info';
  return (
    <div className="rail-head">
      <div className="rail-title">
        <h2>Source activity</h2>
        <RunState />
      </div>
      {runId && <div className="rail-run" title={runId}>Run {runId.replace(/^run_/, '').slice(0, 8)}</div>}
      <p className={`now ${tone}`} aria-live="polite" data-testid="now-line">
        <NowText key={shown?.text ?? idle} text={prettyText(shown?.text ?? idle)} lead={!!shown} />
      </p>
      {slow && <div className="slow" data-testid="slow-state">{slow.text}</div>}
    </div>
  );
}

function NowText({ text, lead }: { text: string; lead: boolean }) {
  const ref = useEnterOnce<HTMLSpanElement>(false, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 220);
  return <span ref={ref} className="now-line">{lead && <span className="lead">Now:</span>}{text}</span>;
}

const STATUS_TEXT: Record<string, string> = {
  queued: 'Starting', running: 'Running', awaiting_input: 'Needs an answer', awaiting_approval: 'Waiting for approval',
  completed: 'Finished', failed: 'Failed', crashed: 'Stopped', budget_exhausted: 'Cap reached',
};

function RunState() {
  const status = useRunSel((v) => v.ui.snap.status);
  const runId = useRunSel((v) => v.runId);
  const mode = useRunSel((v) => v.mode);
  const playing = useRunSel((v) => v.playing);
  const pending = useRunSel((v) => v.pending);
  if (mode === 'sample') {
    if (playing) return <button className="btn small" onClick={() => runStore.pause()} data-testid="sample-pause">Pause</button>;
    return (
      <button className="btn small primary" data-testid="sample-play"
        onClick={() => { if (!runId || !pending) void runStore.loadSample().then(() => runStore.play()); else runStore.play(); }}>
        {pending && runId ? 'Resume replay' : 'Replay recorded run'}
      </button>
    );
  }
  if (!runId) return null;
  const tone = status === 'failed' || status === 'crashed' ? 'bad' : status === 'awaiting_approval' || status === 'budget_exhausted' ? 'warn' : status === 'completed' ? 'ok' : 'live';
  return <span className={`tag ${tone}`}>{STATUS_TEXT[status] ?? status}</span>;
}

function RailStats() {
  const reads = useRunSel((v) => v.feeds.reads);
  const cards = useRunSel((v) => v.feeds.sources.length);
  const calls = useRunSel((v) => v.ui.snap.ledger.length);
  const runId = useRunSel((v) => v.runId);
  if (!runId) return null;
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
  useFlip(box, !catchingUp);
  // newest first; stable keys mean existing cards are moved, never remounted
  const shown = sources.slice(Math.max(0, sources.length - WINDOW)).reverse();
  return (
    <div className="feed" ref={box} data-testid="feed">
      {!shown.length && (
        <div className="feed-empty">
          {runId
            ? 'Each record the run reads appears here with its date and source, marked kept or discarded.'
            : 'When this view runs a scan or reads a profile, every record it reads appears here with its date and source.'}
        </div>
      )}
      {shown.map((c) => <Card key={c.key} card={c} settled={catchingUp} />)}
    </div>
  );
}

const KIND_LABEL: Record<SourceKind, string> = {
  job_move: 'Job move', company: 'Company record', job_post: 'Job post', news: 'News', funding: 'Funding', decider: 'Person record',
};
const MODE_LABEL: Record<string, string> = { live: 'Live', cache: 'Live, cached', fixture: 'Fixture', replay: 'Replay', snapshot: 'Snapshot' };

const Card = memo(function Card({ card, settled }: { card: SourceCard; settled: boolean }) {
  const ref = useEnterOnce<HTMLDivElement>(settled);
  return (
    <div ref={ref} data-flip={card.key} className={`src${card.matched ? '' : ' dim'}`} data-kind={card.kind}>
      <span className="src-icon" aria-label={KIND_LABEL[card.kind]} title={KIND_LABEL[card.kind]}><KindIcon kind={card.kind} /></span>
      <span className="src-title">{prettyText(card.title)}</span>
      <span className="src-meta">
        <span className="src-date">{card.dateLabel}</span>
        {card.company && <span>{card.company}</span>}
        {card.domain && <span>{card.domain}</span>}
        <span className="call">{MODE_LABEL[card.callMode] ?? card.callMode}</span>
      </span>
      <span className={`src-signal${card.matched ? '' : ' off'}`}>{card.matched ? 'Kept' : 'Discarded'}{card.signal ? `: ${prettyText(card.signal)}` : ''}</span>
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
