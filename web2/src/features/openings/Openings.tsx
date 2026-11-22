// Interim openings view (real rows from the desk data) until the Openings feature lands.
import type { CompanyDesk, Opening } from '../../data/desk.ts';
import { isMonthLevel, openingLabel } from '../../data/desk.ts';
import { fmtDate } from '../../lib/format.ts';
import { openEvidence } from '../../shell/ui.ts';

const LABEL = { open: 'Predicted opening', provisional: 'Provisional', watch: 'Watch', held: 'Held' } as const;

export function Openings({ desk }: { desk: CompanyDesk }) {
  if (!desk.openings.length) return <p className="lede">Rule O1 found no unreplaced departures at {desk.company.name} in the last 90 days.</p>;
  return <div className="op-list">{desk.openings.map((o) => <OpeningRow key={o.id} o={o} />)}</div>;
}

function OpeningRow({ o }: { o: Opening }) {
  const label = openingLabel(o);
  return (
    <article className={`surface op-row ${label}`} data-testid={`opening-${o.id}`}>
      <div className="op-top">
        <span className={`st ${label === 'held' ? 'held' : label === 'provisional' ? 'prov' : 'verified'}`}>O1 · {LABEL[label]}{o.windowClosesBy ? ` · window through ${fmtDate(o.windowClosesBy)}` : ''}</span>
        <h3 className="op-role">{o.roleTitle}</h3>
      </div>
      {o.holdReasons?.length ? <p className="op-hold">Held: {o.holdReasons[0]}</p> : null}
      <div className="op-chips">
        {o.reasons.map((r, i) => (
          <button key={i} className="op-chip" data-testid="reason-chip" onClick={() => r.evidenceId && openEvidence(r.evidenceId)} disabled={!r.evidenceId}>
            <span>{r.label}</span>
            <small>{fmtDate(r.date, true)}{isMonthLevel(r.date) ? ' · month-level date' : ''}</small>
          </button>
        ))}
      </div>
    </article>
  );
}
