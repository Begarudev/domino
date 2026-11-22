// The reading desk: every source the engine actually read (evidence.added) lands as a card with its endpoint and
// date, the value the claim rests on highlighted; every signal it extracted (trigger.found) is filed under its
// company. Nothing here is synthesised: one card per Evidence row, one chip per Trigger.
import type { Selection } from '../contract.ts';
import type { DeskView, SourceCard } from './model.ts';
import { day } from './model.ts';

function Highlighted({ card }: { card: SourceCard }) {
  const v = card.value;
  if (v && card.claim.includes(v)) {
    const i = card.claim.indexOf(v);
    return <>{card.claim.slice(0, i)}<mark>{v}</mark>{card.claim.slice(i + v.length)}</>;
  }
  return <>{card.claim}{v ? <> <mark>{v}</mark></> : null}</>;
}

function Card({ card, live, onSelect }: { card: SourceCard; live: boolean; onSelect: (s: Selection) => void }) {
  return (
    <button
      type="button"
      className={`mc-src mc-src--${card.kind}${card.dated ? '' : ' is-undated'}${card.matched === false ? ' is-discarded' : ''}${live ? ' is-live' : ''}`}
      onClick={() => onSelect({ kind: 'evidence', id: card.id })}
    >
      <span className="mc-src__top">
        <span className="mc-src__kind">{card.kindLabel}</span>
        <span className="mc-src__ep">{card.endpoint}</span>
        <span className="mc-src__mode">{card.mode}</span>
      </span>
      <span className="mc-src__claim">{card.matched === undefined ? <Highlighted card={card} /> : card.claim}</span>
      {card.matched !== undefined && (
        <span className={`mc-src__signal${card.matched ? '' : ' is-off'}`}>{card.matched ? `Signal: ${card.value ?? 'matched'}` : 'Read, not relevant'}</span>
      )}
      <span className={`mc-src__date${card.dated ? '' : ' is-none'}`}>{card.dated ? day(card.observedAt, true) : 'Undated: I can\'t verify this'}</span>
    </button>
  );
}

export function Desk({ desk, settledSeq, onSelect }: { desk: DeskView; settledSeq: number; onSelect: (s: Selection) => void }) {
  const cards = desk.cards.slice(-8).reverse();
  return (
    <div className="mc-desk">
      <section className="mc-desk__read" aria-label="Sources read">
        <header className="mc-desk__head">
          <span>Reading</span>
          <span className="mc-desk__fig"><b>{desk.cards.length}</b> sources · <b>{desk.dated}</b> dated</span>
        </header>
        <div className="mc-desk__cards">
          {desk.pending && (
            <div key={`p${desk.pending.seq}`} className="mc-src mc-src--pending">
              <span className="mc-src__top"><span className="mc-src__kind">Calling</span><span className="mc-src__ep">{desk.pending.endpoint}</span>{desk.pending.attempt > 1 && <span className="mc-src__mode">try {desk.pending.attempt}</span>}</span>
              <span className="mc-src__claim">Waiting for the response…</span>
            </div>
          )}
          {cards.map((c, i) => <Card key={c.id} card={c} live={c.seq > settledSeq && i === 0} onSelect={onSelect} />)}
        </div>
      </section>
      <section className="mc-desk__sig" aria-label="Signals extracted">
        <header className="mc-desk__head">
          <span>Signals by company</span>
          <span className="mc-desk__fig"><b>{desk.signalCount}</b> signals · <b>{desk.companies.length}</b> companies</span>
        </header>
        <div className="mc-desk__cos">
          {desk.companies.map((co) => (
            <div key={co.id} className={`mc-co${co.seq > settledSeq ? ' is-live' : ''}`}>
              <button type="button" className="mc-co__name" onClick={() => onSelect({ kind: 'node', id: co.id })}>
                {co.name}
                {co.alias && <span className="mc-co__alias">= {co.alias}</span>}
              </button>
              <div className="mc-co__sigs">
                {co.signals.map((s) => (
                  <span key={s.id} className={`mc-sig mc-sig--${s.kind}${s.seq > settledSeq ? ' is-live' : ''}`}>
                    <i>{s.kindLabel}</i>{s.summary}<em>{day(s.date)}</em>
                  </span>
                ))}
              </div>
            </div>
          ))}
          {desk.keptApart.map((k) => (
            <div key={k} className="mc-co mc-co--apart"><span className="mc-co__note">Kept apart: {k}</span></div>
          ))}
        </div>
      </section>
    </div>
  );
}
