// Side instruments: the live call stream and the credit gauge with a cap you can drag down mid-run.
import { useRef, useState } from 'react';
import type { BudgetState, LedgerEntry, StepName } from '../../../../shared/types.ts';
import type { StreamRow } from './model.ts';
import { STEP_SHORT } from './model.ts';

const MAX_ROWS = 44;

function statusText(e: LedgerEntry): string {
  switch (e.status) {
    case 'ok': return e.mode === 'model' ? `${e.inputTokens}→${e.outputTokens} tok` : e.mode;
    case 'cache_hit': return 'cache hit';
    case 'timeout': return e.injected ? 'timeout · injected' : 'timeout';
    case 'nonsense': return e.injected ? 'bad body · injected' : 'bad body';
    case 'error': return 'error';
    case 'budget_blocked': return 'blocked by cap';
  }
}

function money(e: LedgerEntry): string {
  if (e.provider === 'crustdata') return e.credits ? `${+e.credits.toFixed(2)} cr` : '0 cr';
  if (e.usd) return `$${e.usd.toFixed(4)}`;
  return '—';
}

export function CallStream({ rows, settledSeq, total }: { rows: StreamRow[]; settledSeq: number; total: { calls: number; credits: number } }) {
  const shown = rows.slice(-MAX_ROWS);
  return (
    <section className="mc-stream" aria-label="Calls made by the agent">
      <header className="mc-panel-head">
        <span>Calls</span>
        <span className="mc-panel-head__fig">{total.calls} · {+total.credits.toFixed(1)} cr</span>
      </header>
      <div className="mc-stream__rows" aria-live="off">
        {shown.map((r) => {
          const live = r.seq > settledSeq ? ' is-live' : '';
          if (r.kind === 'call') {
            const e = r.entry;
            const tone = e.status === 'ok' ? (e.mode === 'model' ? 'model' : 'ok') : e.status === 'cache_hit' ? 'cache' : e.status === 'budget_blocked' ? 'blocked' : 'fail';
            return (
              <div key={r.key} className={`mc-call mc-call--${tone}${live}`}>
                <i className="mc-call__dot" />
                <span className="mc-call__ep">{e.endpoint}</span>
                <span className="mc-call__ms">{e.latencyMs >= 1000 ? `${(e.latencyMs / 1000).toFixed(1)} s` : `${e.latencyMs} ms`}</span>
                <span className="mc-call__cr">{money(e)}</span>
                <span className="mc-call__st">{statusText(e)}{e.attempt > 1 ? ` · try ${e.attempt}` : ''}</span>
              </div>
            );
          }
          if (r.kind === 'step') {
            return (
              <div key={r.key} className={`mc-srow mc-srow--step${r.skipped ? ' is-skip' : ''}${live}`}>
                {r.skipped ? `${STEP_SHORT[r.step]}: done before the crash, skipped` : STEP_SHORT[r.step]}
              </div>
            );
          }
          if (r.kind === 'engine') {
            return (
              <div key={r.key} className={`mc-srow mc-srow--engine mc-srow--${r.tone}${live}`}>
                <strong>{r.text}</strong><span>{r.sub}</span>
              </div>
            );
          }
          return <div key={r.key} className={`mc-srow mc-srow--note mc-srow--${r.tone}${live}`}>{r.text}</div>;
        })}
      </div>
    </section>
  );
}

// Square-root scale: a 70-credit run still reads against an 800-credit cap.
const sq = (v: number, max: number) => Math.sqrt(Math.max(0, Math.min(v, max)) / max);
const unsq = (f: number, max: number) => Math.round(f * f * max);

export function Gauge({ budget, scaleMax, onCap, note }: {
  budget: BudgetState; scaleMax: number; onCap?: (credits: number) => void; note: string | null;
}) {
  const tube = useRef<HTMLDivElement>(null);
  const [dragCap, setDragCap] = useState<number | null>(null);
  const cap = dragCap ?? budget.limits.maxCredits;
  const used = budget.used.credits;
  const exhausted = budget.exhausted === 'credits';
  const near = used >= cap * 0.85;
  const ticks = [0, 25, 100, 200, 400, 800, 1600].filter((t) => t <= scaleMax);

  const fromPointer = (clientY: number) => {
    const r = tube.current!.getBoundingClientRect();
    const f = 1 - (clientY - r.top) / r.height;
    return Math.max(Math.ceil(used * 0.5), Math.min(scaleMax, unsq(Math.max(0, Math.min(1, f)), scaleMax)));
  };

  const onDown = (e: React.PointerEvent) => {
    if (!onCap) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragCap(fromPointer(e.clientY));
  };
  const onMove = (e: React.PointerEvent) => { if (dragCap !== null) setDragCap(fromPointer(e.clientY)); };
  const onUp = () => { if (dragCap !== null) { onCap?.(dragCap); setDragCap(null); } };

  const onKey = (e: React.KeyboardEvent) => {
    if (!onCap) return;
    const stepBy = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowDown') { e.preventDefault(); onCap(Math.max(1, cap - stepBy)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); onCap(Math.min(scaleMax, cap + stepBy)); }
  };

  return (
    <section className={`mc-gauge${exhausted ? ' is-exhausted' : near ? ' is-near' : ''}`} aria-label="Credit budget">
      <header className="mc-panel-head"><span>Credits</span></header>
      <div className="mc-gauge__read">
        <b>{+used.toFixed(1)}</b>
        <span>of {cap} cap</span>
      </div>
      <div className="mc-gauge__tube" ref={tube} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {ticks.filter((t) => Math.abs(sq(t, scaleMax) - sq(cap, scaleMax)) > 0.05).map((t) => <span key={t} className="mc-gauge__tick" style={{ bottom: `${sq(t, scaleMax) * 100}%` }}>{t}</span>)}
        <div className="mc-gauge__fill" style={{ transform: `scaleY(${sq(used, scaleMax)})` }} />
        <div
          className={`mc-gauge__cap${onCap ? ' is-draggable' : ''}${dragCap !== null ? ' is-dragging' : ''}`}
          style={{ bottom: `${sq(cap, scaleMax) * 100}%` }}
          onPointerDown={onDown}
          role={onCap ? 'slider' : undefined}
          aria-label="Credit cap"
          aria-valuenow={cap}
          aria-valuemin={0}
          aria-valuemax={scaleMax}
          tabIndex={onCap ? 0 : -1}
          onKeyDown={onKey}
        >
          <span className="mc-gauge__caplabel">cap {cap}</span>
        </div>
      </div>
      <div className="mc-gauge__foot">
        <span>Model ${budget.used.modelUsd.toFixed(3)} <small>of ${budget.limits.maxModelUsd}</small></span>
        <span>{Math.round(budget.used.seconds)} s <small>of {budget.limits.maxSeconds}</small></span>
      </div>
      {note && <p className="mc-gauge__note">{note}</p>}
      {onCap && !note && <p className="mc-gauge__hint">Drag the cap down to squeeze the run</p>}
    </section>
  );
}

export function StepRail({ steps, current, crashedAt }: {
  steps: { step: StepName; status: string; resumedFromCheckpoint?: boolean }[]; current: StepName | null; crashedAt: StepName | null;
}) {
  return (
    <ol className="mc-rail" aria-label="Steps">
      {steps.map((s) => {
        const cls = crashedAt === s.step ? 'crashed' : s.status === 'running' || (s.step === current && s.status !== 'done') ? 'running' : s.status;
        return (
          <li key={s.step} className={`mc-rail__step is-${cls}${s.resumedFromCheckpoint ? ' is-ckpt' : ''}`} title={s.status}>
            <span className="mc-rail__bone"><i /><i /></span>
            <span className="mc-rail__label">{STEP_SHORT[s.step]}</span>
          </li>
        );
      })}
    </ol>
  );
}
