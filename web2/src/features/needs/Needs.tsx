// FEATURE 5b: Verifier (design mock screen 8; anti-wrapper feature 6 and the "I can't verify" rule). Every claim
// behind this company's decisions, each checked: verified against a dated source, open, not met, a guard matched, or
// "I can't verify" (struck, with the reason). Abstentions get the same row weight as hits. The guard card shows a
// decision a guard held in today's scan (the Poolside acqui-hire), beside its dated source. Every row opens its evidence.
import { useMemo, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import type { CompanyDesk } from '../../data/desk.ts';
import { plural } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { openEvidence } from '../../shell/ui.ts';
import {
  CLAIM_LABEL, claimGroups, evDate, evSource, evidenceMap, guardClause, guardLabel, useDossier, useHeldExample,
} from '../chains/model.ts';
import type { ClaimRow, ClaimState } from '../chains/model.ts';
import '../chains/chains.css';
import './verifier.css';
import './verifier-color.css';
import { HowComputed } from '../buyers/HowComputed.tsx';

const ORDER: ClaimState[] = ['verified', 'open', 'not_met', 'guard', 'cant', 'removed', 'not_evaluated'];
const MARK: Record<ClaimState, string> = { verified: '✓', open: '○', not_met: '×', guard: '×', cant: '×', removed: '×', not_evaluated: '–' };

export function Needs({ desk }: { desk: CompanyDesk }) {
  const dq = useDossier(desk.company.id);
  const held = useHeldExample(desk);
  const groups = useMemo(() => claimGroups(desk, dq.data ?? null), [desk, dq.data]);
  const ev = useMemo(() => evidenceMap(desk.evidence, dq.data?.evidence), [desk.evidence, dq.data]);
  const [filter, setFilter] = useState<ClaimState | null>(null);
  const all = groups.flatMap((g) => g.rows);
  const tally = ORDER.map((s) => ({ s, n: all.filter((r) => r.state === s).length })).filter((t) => t.n > 0 || t.s === 'cant');
  const verified = all.filter((r) => r.state === 'verified').length;
  const enter = useEnterOnce<HTMLDivElement>(true);

  return (
    <div className="ver" ref={enter}>
      <GuardCard held={held} />
      <aside className="panel ver-sum" aria-label="Claims checked">
        <header><h2>Claims checked · {desk.company.name}<HowComputed endpoint="GET /api/companies/:id and GET /api/companies/:id/dossier"
          rule="Every clause of every rule run on this company (O1, R1, guards) is checked against a dated record: verified, open, not met, guard matched, or I can’t verify (timed out or no source)."
          source={`Crustdata person search, company enrich, job search and news, as recorded in the evidence ledger${desk.checkedAt ? `; checked ${desk.checkedAt.slice(0, 10)}` : ''}.`} /></h2><span className="faint" data-num>{verified} of {all.length} verified</span></header>
        <div className="ver-tally" role="group" aria-label="Filter claims by result">
          {tally.map(({ s, n }) => (
            <button key={s} className={`vt vt-${s}`} aria-pressed={filter === s} onClick={() => setFilter((f) => (f === s ? null : s))}>
              <span className={`vt-mark m-${s}`} aria-hidden>{MARK[s]}</span>
              <span className="vt-l">{CLAIM_LABEL[s]}</span>
              <b data-num>{n}</b>
            </button>
          ))}
        </div>
        <p className="ver-foot">Struck claims never reach a draft or a candidate. A timed-out check reads “I can’t verify” and keeps the decision provisional or held.</p>
      </aside>

      <section className="panel ver-claims">
        <header>
          <h2>{filter ? `${CLAIM_LABEL[filter]} · ${plural(all.filter((r) => r.state === filter).length, 'claim')} behind ${desk.company.name}’s decisions` : `Every claim behind ${desk.company.name}’s decisions`}</h2>
          {filter ? <button className="btn sm ghost" onClick={() => setFilter(null)}>Show all {all.length}</button>
            : <span className="faint">{plural(groups.length, 'decision')} · click a row for its source</span>}
        </header>
        {dq.error && !dq.data && <p className="src-note ver-note">No company file for {desk.company.name} ({dq.error}); showing the openings’ clauses only.</p>}
        {!all.length && !dq.loading && <p className="ver-empty">No rule has evaluated {desk.company.name} yet, so there is nothing to verify.</p>}
        <table className="t ver-t">
          <colgroup><col style={{ width: 32 }} /><col /><col style={{ width: 132 }} /><col style={{ width: 128 }} /><col style={{ width: 230 }} /></colgroup>
          <thead><tr><th /><th>Claim</th><th>Result</th><th>Date</th><th>Source</th></tr></thead>
          {groups.map((g) => {
            const rows = filter ? g.rows.filter((r) => r.state === filter) : g.rows;
            if (!rows.length) return null;
            return (
              <tbody key={g.key}>
                <tr className="vg"><td colSpan={5}><span className="rid">{g.rule}</span><b>{g.title}</b><span className={g.chip.cls}>{g.chip.label}</span></td></tr>
                {rows.map((r) => <ClaimTr key={r.key} r={r} ev={ev} />)}
              </tbody>
            );
          })}
        </table>
      </section>
    </div>
  );
}

function ClaimTr({ r, ev }: { r: ClaimRow; ev: Map<string, Evidence> }) {
  // A pattern is dated by its newest part; a guard by the first report that tripped it (the engine lists it first).
  const found = r.evidenceIds.map((id) => ev.get(id)).filter((e): e is Evidence => !!e);
  const first = r.state === 'guard' ? found[0] : [...found].sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''))[0];
  const id = first?.id ?? r.evidenceIds[0];
  const struck = r.state === 'cant' || r.state === 'removed';
  const checked = r.detail?.match(/checked (\d{1,2} \w{3} \d{4})/)?.[1];
  const date = first ? evDate(first) : checked ?? '–';
  const source = first ? evSource(first) : r.state === 'cant' || r.state === 'removed' ? 'no source' : r.detail ? r.detail.split(/[;.]/)[0] : 'no source';
  const more = r.evidenceIds.length - 1;
  return (
    <tr data-testid="verify-row" data-state={r.state} className={id ? 'go' : undefined} tabIndex={id ? 0 : undefined}
      onClick={id ? () => openEvidence(id) : undefined} onKeyDown={id ? (e) => { if (e.key === 'Enter') openEvidence(id); } : undefined}>
      <td><span className={`vt-mark m-${r.state}`} aria-hidden>{MARK[r.state]}</span></td>
      <td>
        <span className={struck ? 'struck' : undefined}>{r.text}</span>
        {r.reason && <span className="ver-reason">{r.reason}</span>}
      </td>
      <td>{r.state === 'cant' ? <span className="cant">I can’t verify</span> : <span className={`ver-st ver-stp s-${r.state}`}><i aria-hidden />{CLAIM_LABEL[r.state]}</span>}</td>
      <td className="ver-date">{date}{/^[A-Z][a-z]{2} \d{4}$/.test(date) && <span className="ver-month">month-level</span>}</td>
      <td className="ver-src" title={source}><span>{source}</span>{more > 0 && <span className="faint"> +{more}</span>}</td>
    </tr>
  );
}

// ---------------------------------------------------------------- the guard card

function GuardCard({ held }: { held: ReturnType<typeof useHeldExample> }) {
  const o = held.opening;
  if (!o) {
    if (held.loading) return <div className="panel guard ghost" aria-hidden />;
    return (
      <div className="panel guard" data-testid="guard-card">
        <div className="pad"><span className="st plain">No hold</span><p className="muted">No guard held a decision in today’s scan{held.error ? ` (${held.error})` : ''}.</p></div>
      </div>
    );
  }
  const g = guardClause(o)!;
  const dep = o.clauses?.find((c) => c.id === 'o1.departures');
  const ev = evidenceMap(held.evidence);
  const srcs = g.evidenceIds.map((id) => ev.get(id)).filter((e): e is Evidence => !!e);
  const lead = srcs[0];
  const quote = lead ? (typeof lead.value === 'string' ? lead.value : lead.claim) : null;
  const note = g.detail?.match(/[^.]*company-level[^.]*\./)?.[0]?.trim();
  const others = (o.clauses ?? []).filter((c) => c.id.startsWith('guard.') && c.state === 'failed' && c.id !== g.id);
  const n = dep?.text.match(/^(\d+)/)?.[1];
  const label = guardLabel(g.id);
  const alsoHeld = held.heldRows.filter((r) => !r.label.startsWith(`${o.companyName} ·`));
  return (
    <article className="panel guard" data-testid="guard-card">
      <div className="guard-head">
        <div className="guard-tags">
          <span className="st held">Held: {label}</span>
          <span className="faint">{o.companyName} · O1{n ? ` group of ${n}` : ''} · {o.roleTitle}</span>
          {held.example && <span className="guard-ex">Guard example from today’s scan</span>}
        </div>
        <h2>{o.companyName}’s departures are not an opening</h2>
      </div>
      <div className="steps">
        <button className={dep?.state === 'met' ? 'done' : ''} onClick={() => dep?.evidenceIds[0] && openEvidence(dep.evidenceIds[0])}>
          <span>Step 1</span><b>Departure pattern met</b>
        </button>
        <button className="done" onClick={() => lead && openEvidence(lead.id)}>
          <span>Step 2</span><b>{label[0].toUpperCase() + label.slice(1)} guard matched</b>
        </button>
        <div className="cur"><span>Decision</span><b>Held</b></div>
      </div>
      {quote && lead && (
        <button className="guard-quote" onClick={() => openEvidence(lead.id)}>
          <span className="q">“{quote.replace(/^“|”$/g, '')}”</span>
          <span className="guard-src"><span className="srclink">{evSource(lead)}</span> · {evDate(lead)} · news search, publication date read from the page</span>
        </button>
      )}
      {srcs.slice(1).map((e) => (
        <button key={e.id} className="guard-also" onClick={() => openEvidence(e.id)}>
          Also reported: <span className="srclink">{evSource(e)}</span> · {evDate(e)}
        </button>
      ))}
      {note && <p className="guard-note">{note} So the group is held, not predicted.</p>}
      {(others.length > 0 || alsoHeld.length > 0) && (
        <ul className="guard-more">
          {others.map((c) => (
            <li key={c.id}><span className="st held">Also matched</span><button className="linkish-row" onClick={() => c.evidenceIds[0] && openEvidence(c.evidenceIds[0])}>{c.text}</button></li>
          ))}
          {alsoHeld.map((r) => (
            <li key={r.label}><span className="st held">Also held today</span><button className="linkish-row" onClick={() => r.evidenceId && openEvidence(r.evidenceId)}>{r.label}: {(r.detail ?? '').split(';')[0]}</button></li>
          ))}
        </ul>
      )}
    </article>
  );
}
