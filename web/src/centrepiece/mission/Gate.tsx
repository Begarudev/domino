// The approval gate: the one irreversible step. Hold to approve; the message folds, is sealed, and drops into the
// team test inbox exactly once. A second approval shows the idempotency key turning it away.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GateView } from './model.ts';
import { clockTime, day, shortKey } from './model.ts';

const HOLD_MS = 1100;

function Cited({ text, gate }: { text: string; gate: GateView }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[(\d+)\]$/);
        if (!m) return <span key={i}>{p}</span>;
        const cite = gate.draft.citations.find((c) => c.marker === Number(m[1]));
        const ev = cite ? gate.evidence.get(cite.evidenceId) : undefined;
        return (
          <sup key={i} className="mc-cite" title={ev ? `${ev.claim} (${ev.source.endpoint}, ${day(ev.observedAt, true)})` : 'source'}>
            {m[1]}<span>{ev ? day(ev.observedAt) : ''}</span>
          </sup>
        );
      })}
    </>
  );
}

/** The draft assembles sentence by sentence from the verifier's checks; removed sentences stay visible, struck out. */
function Body({ gate, live }: { gate: GateView; live: boolean }) {
  const checks = gate.draft.checks;
  if (!checks.length) return <p className="mc-gate__body"><Cited text={gate.draft.body} gate={gate} /></p>;
  return (
    <p className={`mc-gate__body${live ? ' is-live' : ''}`}>
      {checks.map((c, i) => (
        <span key={i} className={`mc-sent mc-sent--${c.status}`} style={{ ['--i' as string]: i } as CSSProperties}>
          <Cited text={c.sentence} gate={gate} />
          {c.status === 'removed' && <em className="mc-sent__why">Removed by the verifier: {c.note ?? 'no evidence row supports it'}</em>}{' '}
        </span>
      ))}
    </p>
  );
}

export function Gate({ gate, settledSeq, onApprove, reducedMotion }: {
  gate: GateView; settledSeq: number; onApprove?: (approvalId: string) => void; reducedMotion: boolean;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentLive = !!gate.sent && gate.sent.seq > settledSeq && !reducedMotion;
  const lastDup = gate.duplicates.at(-1);
  const dupLive = !!lastDup && lastDup.seq > settledSeq;
  const [dupFlash, setDupFlash] = useState(0);

  useEffect(() => {
    if (!dupLive || !lastDup) return;
    setDupFlash(lastDup.seq);
    const t = setTimeout(() => setDupFlash(0), 3600);
    return () => clearTimeout(t);
  }, [dupLive, lastDup?.seq]);

  const start = () => {
    if (!onApprove || !gate.approval) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onApprove(gate.approval!.id);
    }, reducedMotion ? 0 : HOLD_MS);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => cancel, []);

  const state = gate.sent ? 'sent' : 'pending';
  // After the seal lands, the band shrinks to a receipt strip that keeps "Approve again" in reach.
  const [sealed, setSealed] = useState(!!gate.sent && !sentLive);
  useEffect(() => {
    if (!gate.sent) { setSealed(false); return; }
    if (!sentLive) { setSealed(true); return; }
    setSealed(false);
    const t = setTimeout(() => setSealed(true), 2300);
    return () => clearTimeout(t);
  }, [gate.sent?.seq]);
  const recipient = gate.decider ? `${gate.decider.name}, ${gate.decider.title} at ${gate.decider.company}` : 'No decider verified';

  return (
    <section className={`mc-gate mc-gate--${state}${state === 'sent' ? (sealed ? ' is-sealed' : ' is-sealing') : ''}${dupFlash ? ' is-dup' : ''}`} aria-label="Approval gate">
      {sealed && gate.sent ? (
        <div className="mc-gate__strip">
          <span className="mc-env" aria-hidden="true"><i /><b>1</b></span>
          <span className="mc-gate__striptext">
            <strong>One message sent to the team test inbox</strong>
            <span>{gate.decider ? `Draft for ${gate.decider.name} · ${gate.decider.company} · ` : ''}{clockTime(gate.sent.action.executedAt)} · key <code>{shortKey(gate.sent.action.idempotencyKey)}</code></span>
          </span>
          {onApprove && gate.approval && <button type="button" className="mc-again" onClick={() => onApprove(gate.approval!.id)}>Try approving twice</button>}
          <span className={`mc-gate__dup${dupFlash ? ' is-flash' : ''}`}>
            {gate.duplicates.length ? `Already sent, skipped${gate.duplicates.length > 1 ? ` ×${gate.duplicates.length}` : ''}` : 'One key, one send'}
          </span>
        </div>
      ) : (<>
      <div className="mc-gate__band">
        <div className="mc-gate__who">
          <span className="mc-gate__k">To</span>
          <strong>{recipient}</strong>
          <span className="mc-gate__k">Checks</span>
          <span>{gate.draft.citations.length} sentences cite a dated source</span>
          <span>{gate.removed} removed by the verifier</span>
          {gate.draft.unverifiable.map((u) => <span key={u.claim} className="mc-gate__cant">I can't verify: {u.claim}</span>)}
        </div>

        <div className="mc-gate__letter">
          <div className="mc-gate__paper">
            <span className="mc-gate__subject">{gate.draft.subject}</span>
            <Body gate={gate} live={gate.requestedSeq > settledSeq && !reducedMotion} />
          </div>
          <div className="mc-gate__seal" aria-hidden="true"><span>sent</span><b>once</b></div>
        </div>

        <div className="mc-gate__act">
          {state === 'pending' ? (
            onApprove ? (
              <button
                type="button"
                className={`mc-hold${holding ? ' is-holding' : ''}`}
                style={{ ['--hold' as string]: `${HOLD_MS}ms` }}
                onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) start(); }}
                onKeyUp={cancel}
              >
                <i className="mc-hold__fill" />
                <span className="mc-hold__label">{holding ? 'Keep holding' : 'Hold to approve'}</span>
                <span className="mc-hold__sub">Sends once to the team test inbox</span>
              </button>
            ) : (
              <div className="mc-gate__await"><strong>Waiting for a person</strong><span>Approve it in the Drafts panel</span></div>
            )
          ) : (
            <div className="mc-gate__done">
              <strong>Sent once</strong>
              <span>Team test inbox · {clockTime(gate.sent!.action.executedAt)}</span>
              <span className="mc-gate__key">key {shortKey(gate.sent!.action.idempotencyKey)}</span>
              {onApprove && gate.approval && (
                <button type="button" className="mc-again" onClick={() => onApprove(gate.approval!.id)}>Approve again</button>
              )}
            </div>
          )}
          {gate.waitingMore > 0 && <span className="mc-gate__more">{gate.waitingMore} more drafts wait in the Drafts panel</span>}
        </div>
      </div>

      <div className="mc-inbox" aria-live="polite">
        <span className="mc-inbox__tray"><i /></span>
        <span className="mc-inbox__label">Team test inbox</span>
        <span className="mc-inbox__count">{gate.sent ? 1 : 0}</span>
        {(dupFlash || gate.duplicates.length > 0) && (
          <span className={`mc-inbox__dup${dupFlash ? ' is-flash' : ''}`}>
            Already sent, skipped{gate.duplicates.length > 1 ? ` ×${gate.duplicates.length}` : ''}
          </span>
        )}
      </div>
      </>)}
    </section>
  );
}
