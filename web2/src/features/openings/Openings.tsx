// Company › Act › Recruitment (design mock screen 4): who left, what rule O1 decided from it, and who you can hire.
// Every decision is shown as its clauses (met ✓ / open ○ / failed ✗ / I can't verify), never as a score. Every count
// opens its records; every record opens its dated source.
import { useMemo, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import type { CompanyDesk, Opening } from '../../data/desk.ts';
import { useRoute } from '../../data/router.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { fmtDate, fmtInt, plural } from '../../lib/format.ts';
import { openEvidence, useShell } from '../../shell/ui.ts';
import { HireTable } from '../matches/HireTable.tsx';
import type { Clause, DepartureRow } from './derive.ts';
import {
  clauseCount, departureRows, evidenceIndex, familyLabel, guardName, isMonthPrecision, proofSteps, sentenceCase, splitClauses, stateChip, windowText,
} from './derive.ts';
import { FunnelStrip } from './Funnel.tsx';
import './openings.css';

/** "Why this target?" as the engine states it: the eligibility clauses and the stated order rule. No score. */
interface Ranking { position: number; of: number; rule: string; because: string[] }
interface Why { rule: string; statement: string; verdict: string; ranking?: Ranking; companyRanking?: Ranking }
type OpeningWithWhy = Opening & { why?: Why };

export function Openings({ desk }: { desk: CompanyDesk }) {
  const route = useRoute();
  const routeId = route.page === 'company' ? route.id : desk.company.id;
  const source = useShell((s) => s.pageSource);
  const [pick, setPick] = useState(0);
  const opening = (desk.openings[pick] ?? desk.openings[0] ?? null) as OpeningWithWhy | null;
  const ev = useMemo(() => evidenceIndex(desk), [desk]);
  const rows = useMemo(() => departureRows(desk, opening, ev), [desk, opening, ev]);

  return (
    <div className="rec" data-testid="recruitment">
      {desk.openings.length > 1 && (
        <div className="rec-pick" role="tablist" aria-label="Rule decisions">
          {desk.openings.map((o, i) => (
            <button key={o.id} type="button" role="tab" aria-selected={o === opening} className={`btn sm ${o === opening ? 'on' : ''}`} onClick={() => setPick(i)}>
              {familyLabel(o.roleFamily)} · {stateChip(o).text.split(' · ')[0]}
            </button>
          ))}
        </div>
      )}
      <div className="rec-top">
        <div className="rec-col">
          <Departures rows={rows} opening={opening} />
          <FunnelStrip runId={desk.runId} />
        </div>
        {opening ? <OpeningPanel key={opening.id} o={opening} ev={ev} rows={rows} /> : <NoOpening desk={desk} />}
      </div>
      <HireTable desk={desk} opening={opening} routeId={routeId} source={source} ev={ev} />
    </div>
  );
}

// ---------------------------------------------------------------- departures

function Departures({ rows, opening }: { rows: DepartureRow[]; opening: Opening | null }) {
  const yes = rows.filter((r) => r.conclusive === true).length;
  const no = rows.filter((r) => r.conclusive === false).length;
  const win = windowText(opening);
  return (
    <div className="panel rec-dep" data-testid="departures">
      <header>
        <h2>Departures, {familyLabel(opening?.roleFamily)}</h2>
        <span className="faint" data-num>{yes + no > 0 ? `${plural(yes, 'conclusive departure')}${no ? ` · ${fmtInt(no)} struck` : ''}` : `${plural(rows.length, 'departure')} in 90 days`}</span>
      </header>
      {!rows.length ? (
        <p className="rec-empty"><span className="muted">No dated departure in this role family in the last 90 days.</span></p>
      ) : (
        <table className="t">
          <thead><tr><th>Person, role</th><th>Went to</th><th>Left</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <DepRow key={r.d.id} r={r} start={win?.split("–")[0].replace(/ \d{4}$/, "") ?? null} />)}</tbody>
        </table>
      )}
      {rows.some((r) => r.month?.length === 7) && (
        <p className="rec-foot">
          Month-level dates{win ? <> count only when the whole month is inside the window, {win.replace(/ (\d{4})(?=–.* \1$)/, '')}.</> : '.'}
        </p>
      )}
    </div>
  );
}

function DepRow({ r, start }: { r: DepartureRow; start: string | null }) {
  const ref = useEnterOnce<HTMLTableRowElement>();
  const s = r.conclusive === false ? 'struck' : undefined;
  return (
    <tr ref={ref} className="rec-click" tabIndex={0} data-testid={`departure-${r.d.id}`}
      onClick={() => openEvidence(r.d.evidenceId)} onKeyDown={(e) => { if (e.key === 'Enter') openEvidence(r.d.evidenceId); }}
      title="Open the dated source">
      <td className={s}>{r.d.initial}, {r.d.role}</td>
      <td className={s}>{r.d.toCompanyName ?? 'not stated'}</td>
      <td className={s} data-num>{r.month ? fmtDate(r.month, true) : 'undated'}</td>
      <td>
        {r.conclusive === true && <span className="rec-pill"><i aria-hidden />conclusive</span>}
        {r.conclusive === false && <span className="muted">{r.reason}{start ? ` (${start})` : ''}</span>}
        {r.conclusive === null && <span className="faint">not assessed</span>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- the decision

function OpeningPanel({ o, ev, rows }: { o: OpeningWithWhy; ev: Map<string, Evidence>; rows: DepartureRow[] }) {
  const chip = stateChip(o);
  const { rule, guards } = splitClauses(o);
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  return (
    <div className="panel rec-op" data-testid={`opening-${o.id}`}>
      <header>
        <h2>{o.status === 'held' ? 'Rule decision' : 'Predicted opening'}</h2>
        <span className={`st ${chip.cls}`} data-testid="opening-state">{chip.text}</span>
      </header>
      <div className="pad">
        <p className="rec-role">{sentenceCase(o.roleTitle)}</p>
        <p className="faint rec-role-sub">O1 · evaluated {fmtDate(o.predictedAt, true)}{o.provisional && o.windowClosesBy ? ` · provisional, window closes ${fmtDate(o.windowClosesBy)}` : ''} · {familyLabel(o.roleFamily)} role family</p>
        <ol className="rec-proof" aria-label="The decision, dated" data-testid="proof">
          {proofSteps(o, rows).map((s) => (
            <li key={s.text} className={`tone-${s.tone}`}>
              {s.clauseId
                ? <button type="button" onClick={() => setOpen(s.clauseId)} aria-label={`${s.text}: show the clause`}>{s.text}</button>
                : <span>{s.text}</span>}
            </li>
          ))}
        </ol>
        {o.status === 'held' && <HeldCard o={o} />}
        <ul className="clauses rec-clauses">
          {rule.map((c) => <ClauseRow key={c.id} c={c} o={o} ev={ev} open={open === c.id} onToggle={() => toggle(c.id)} />)}
          {guards.filter((c) => c.state !== 'met').map((c) => <ClauseRow key={c.id} c={c} o={o} ev={ev} open={open === c.id} onToggle={() => toggle(c.id)} />)}
          {guards.some((c) => c.state === 'met') && (
            <GuardsRow passed={guards.filter((c) => c.state === 'met')} ev={ev} open={open === '__guards'} onToggle={() => toggle('__guards')} />
          )}
          {o.why && <WhyRow why={o.why} open={open === '__why'} onToggle={() => toggle('__why')} />}
        </ul>
        {!rule.length && !guards.length && <p className="muted">The engine returned this decision without its clauses.</p>}
      </div>
    </div>
  );
}

const MARK: Record<Clause['state'], { sym: string; cls: string; label: string }> = {
  met: { sym: '✓', cls: 'tick', label: 'met' },
  open: { sym: '○', cls: 'open-c', label: 'open' },
  failed: { sym: '✗', cls: 'rec-fail', label: 'failed' },
  cant_verify: { sym: '?', cls: 'open-c', label: 'can’t verify' },
};

function ClauseRow({ c, o, ev, open, onToggle }: { c: Clause; o: Opening; ev: Map<string, Evidence>; open: boolean; onToggle: () => void }) {
  const m = MARK[c.state];
  const count = clauseCount(c, o);
  return (
    <li className={`rec-clause ${open ? 'x' : ''} st-${c.state}`} data-testid={`clause-${c.id}`}>
      <button type="button" className="rec-clause-btn" onClick={onToggle} aria-expanded={open}>
        <span className={m.cls} aria-label={m.label}>{m.sym}</span>
        <span className="rec-clause-text">
          {c.state === 'cant_verify' ? <><span className="struck">{c.text}</span><span className="cant">I can’t verify</span></> : c.text}
        </span>
        <span className={count.opens ? 'count rec-count' : 'faint rec-count'}>{count.text}</span>
      </button>
      <div className={`rec-x ${open ? 'on' : ''}`} aria-hidden={!open}>
        <div className="rec-x-in">
          <div className="rec-why">
            {c.detail && <p>{c.detail}</p>}
            {c.evidenceIds.length > 0 ? (
              <ul className="rec-ev">
                {c.evidenceIds.map((id) => <EvRow key={id} id={id} e={ev.get(id)} tab={open} />)}
              </ul>
            ) : <p className="faint">No record found, so none to cite.</p>}
          </div>
        </div>
      </div>
    </li>
  );
}

function EvRow({ id, e, tab }: { id: string; e?: Evidence; tab: boolean }) {
  const date = e?.observedAt ? (isMonthPrecision(e) ? fmtDate(e.observedAt.slice(0, 7), true) : fmtDate(e.observedAt, true)) : null;
  return (
    <li>
      <button type="button" className="rec-ev-btn" onClick={() => openEvidence(id)} tabIndex={tab ? 0 : -1} data-testid={`clause-ev-${id}`}>
        <span className="rec-ev-date" data-num>{date ?? 'undated'}</span>
        <span className="rec-ev-claim">{e?.claim ?? `Source ${id}`}</span>
      </button>
    </li>
  );
}

/** The false-drain guards that passed, folded into one row; each one's text, scope and sources open below. */
function GuardsRow({ passed, ev, open, onToggle }: { passed: Clause[]; ev: Map<string, Evidence>; open: boolean; onToggle: () => void }) {
  const names = passed.map((c) => guardName(c.id).replace(/ guard$/, ''));
  return (
    <li className={`rec-clause ${open ? 'x' : ''} st-met`} data-testid="clause-guards">
      <button type="button" className="rec-clause-btn" onClick={onToggle} aria-expanded={open}>
        <span className="tick" aria-label="met">✓</span>
        <span className="rec-clause-text">{passed.length === 1 ? 'False-drain guard passed' : `${fmtInt(passed.length)} false-drain guards passed`}: {names.join(', ')}</span>
        <span className="count rec-count">{plural(passed.length, 'check')}</span>
      </button>
      <div className={`rec-x ${open ? 'on' : ''}`} aria-hidden={!open}>
        <div className="rec-x-in">
          <ul className="rec-guards">
            {passed.map((c) => (
              <li key={c.id} data-testid={`clause-${c.id}`}>
                <p className="rec-guard-t"><span className="tick">✓</span> {c.text}</p>
                {c.detail && <p>{c.detail}</p>}
                {c.evidenceIds.length > 0
                  ? <ul className="rec-ev">{c.evidenceIds.map((id) => <EvRow key={id} id={id} e={ev.get(id)} tab={open} />)}</ul>
                  : <p className="faint">No record found, so none to cite.</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </li>
  );
}

function WhyRow({ why, open, onToggle }: { why: Why; open: boolean; onToggle: () => void }) {
  const co = why.companyRanking;
  return (
    <li className={`rec-clause rec-whyrow ${open ? 'x' : ''}`} data-testid="why-target">
      <button type="button" className="rec-clause-btn" onClick={onToggle} aria-expanded={open}>
        <span className="open-c" aria-hidden>§</span>
        <span className="rec-clause-text">Why this target? {co && <span className="muted">{fmtInt(co.position)} of {fmtInt(co.of)} companies, ordered by {co.rule.replace(/^Companies are ordered by /, "").replace(/ \([^)]*\)/g, "").replace(/\.$/, "")}. No score.</span>}</span>
        <span className="count rec-count">the rule</span>
      </button>
      <div className={`rec-x ${open ? 'on' : ''}`} aria-hidden={!open}>
        <div className="rec-x-in">
          <div className="rec-why">
            <p><b>Rule {why.rule}.</b> {why.statement}</p>
            {co && <p><b>Order.</b> {co.rule} Here: {co.because.join('; ')}.</p>}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Held: the departure pattern met, then a false-drain guard matched. Each reason opens its dated source. */
function HeldCard({ o }: { o: Opening }) {
  const failed = (o.clauses ?? []).filter((c) => c.id.startsWith('guard.') && c.state === 'failed');
  const news = o.reasons.filter((r) => r.kind === 'news' && r.evidenceId);
  const sourceFor = (hold: string): string | null => {
    const r = news.find((n) => hold.includes(n.label));
    if (r?.evidenceId) return r.evidenceId;
    if (/restructure|headcount/i.test(hold)) return failed.find((c) => c.id === 'guard.restructure')?.evidenceIds[0] ?? null;
    return null;
  };
  return (
    <div className="rec-held" data-testid="held-card">
      <p className="rec-held-h">Held, not predicted. The departures met O1, then {failed.length === 1 ? `the ${guardName(failed[0].id)}` : `${fmtInt(failed.length)} guards`} matched:</p>
      <ul>
        {(o.holdReasons ?? []).map((h, i) => {
          const id = sourceFor(h);
          return <li key={i}>{id ? <button type="button" className="srclink rec-held-src" onClick={() => openEvidence(id)}>{h}</button> : <span>{h}</span>}</li>;
        })}
      </ul>
    </div>
  );
}

function NoOpening({ desk }: { desk: CompanyDesk }) {
  return (
    <div className="panel rec-op" data-testid="no-opening">
      <header><h2>Rule decision</h2><span className="st plain">O1 · no opening</span></header>
      <div className="pad">
        <p className="rec-role">No predicted opening</p>
        <p className="muted">
          Rule O1 needs 2 or more conclusive dated departures in one role family within 90 days, and no replacement post or
          hire. {desk.departures.length ? `The ${fmtInt(desk.departures.length)} dated departures here don’t meet it.` : `No dated departure at ${desk.company.name} reached the rule.`}
        </p>
      </div>
    </div>
  );
}
