// FEATURE 5a: Chains, the rules registry (design mock screen 7; anti-wrapper feature 6). One card per pre-registered
// rule (O1, R1, CONTAGION, DISPLACEMENT, DIRECT) and the false-drain guards: statement, thresholds, lock time and
// today's live counts from GET /api/rules, plus how each rule stands for this company (the dossier) and an example
// chain only where real records make one. CONTAGION and DISPLACEMENT show counts and their shape, no narration.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DossierRule } from '../../../../shared/desk.ts';
import type { CompanyDesk, CompanyDossier, Opening } from '../../data/desk.ts';
import { invalidate } from '../../data/query.ts';
import { fmtDate, fmtInt, plural } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { openEvidence } from '../../shell/ui.ts';
import type { RuleCard } from './model.ts';
import {
  clauseMonths, evDate, evidenceMap, familyShort, guardClause, guardLabel, lockParts, notConclusive, ordinal, ruleStateChip,
  useDossier, useHeldExample, useRules, watchCount,
} from './model.ts';
import './chains.css';
import { DominoGraph } from '../network/DominoGraph.tsx';

export function Chains({ desk }: { desk: CompanyDesk }) {
  const rules = useRules();
  const dq = useDossier(desk.company.id);
  const dossier = dq.data;
  const held = useHeldExample(desk);
  const enter = useEnterOnce<HTMLDivElement>(!!rules.data);
  const byId = (id: string) => rules.data?.find((r) => r.id === id);
  const company = (id: string) => dossier?.rules.find((r) => r.id === id);
  const o1 = byId('O1');
  const r1 = byId('R1');

  if (rules.error && !rules.data) {
    return (
      <div className="empty-act" role="alert">
        <p><b>Couldn’t load Chains.</b> The rules registry didn’t answer, so nothing is shown rather than a guess.</p>
        <details className="faint"><summary>Details</summary>{rules.error}</details>
        <button className="btn sm" onClick={() => invalidate('rules')} disabled={rules.loading}>{rules.loading ? 'Retrying…' : 'Try again'}</button>
      </div>
    );
  }
  if (!rules.data) {
    return <div className="reg" aria-hidden><div className="rule-card ghost" /><div className="rule-card ghost" /><div className="rule-card ghost" /><div className="rule-card ghost" /></div>;
  }

  const rest = rules.data.filter((r) => r.id !== 'O1' && r.id !== 'R1');
  return (
    <div className="reg" ref={enter}>
      <div className="reg-wide"><DominoGraph desk={desk} dossier={dossier ?? null} /></div>
      {dq.error && !dossier && <p className="src-note reg-wide">No company file for {desk.company.name} yet ({dq.error}), so the per-company rows are left out.</p>}
      {dossier && dossier.rules.length > 0 && (
        <div className="reg-wide verdict" data-testid="chains-verdict">
          <b>{desk.company.name}</b>
          {dossier.rules.map((r) => {
            const c = ruleStateChip(r.state);
            const w = r.id === 'R1' ? watchCount(r) : null;
            return <span key={r.id} className="verdict-i"><span className="rid">{r.id}</span><span className={c.cls}>{w && r.state === 'not_met' ? `${w.have} of ${w.need}` : c.label}</span></span>;
          })}
        </div>
      )}
      {/* explicit columns: the cross-company drain and its watchlist first, then the guards that hold and O1 */}
      <div className="reg-col">
        {r1 && <RuleCardView rule={r1} desk={desk} mine={company('R1')} example={<R1Chain desk={desk} rule={company('R1')} />} />}
        <WatchCard desk={desk} dossier={dossier ?? null} loading={dq.loading} />
      </div>
      <div className="reg-col">
        {o1 && <GuardsCard o1={o1} held={held} />}
        {o1 && <RuleCardView rule={o1} desk={desk} mine={company('O1')} example={<O1Chain desk={desk} />} />}
      </div>
      <div className="reg-col reg-rest">
        {rest.map((r) => <RuleCardView key={r.id} rule={r} desk={desk} mine={company(r.id)} example={<PatternChain id={r.id} />} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one registered rule

function RuleCardView({ rule, desk, mine, example }: { rule: RuleCard; desk: CompanyDesk; mine?: DossierRule; example: ReactNode }) {
  const lock = lockParts(rule.lockedAt);
  const chip = mine ? ruleStateChip(mine.state) : null;
  return (
    <article className="rule-card" data-testid={`rule-${rule.id}`}>
      <div className="id">
        <span className="rid">{rule.id}</span>
        <HeadCount rule={rule} />
      </div>
      <h3>{rule.name}</h3>
      <p className="def">{rule.statement}</p>
      {rule.thresholds.length > 0 && (
        <ul className="thr" aria-label="Thresholds">{rule.thresholds.map((t) => <li key={t}>{t}</li>)}</ul>
      )}
      {rule.guards.length > 0 && <p className="rc-guards faint">{plural(rule.guards.length, 'false-drain guard')} apply; any match means Held.</p>}
      {example}
      <div className="rc-today">
        <span className="rc-k">Today</span>
        <span className="rc-counts">
          {rule.counts.map((c) => <span key={c.label}><b data-num>{fmtInt(c.value)}</b> {c.label}</span>)}
          {rule.sourceRunId && <span className="rc-run">counted in run <span className="mono" title={rule.sourceRunId}>{rule.sourceRunId.replace(/^run_/, '').slice(0, 8)}</span>, all companies</span>}
        </span>
      </div>
      {mine && chip && (
        <div className="rc-mine">
          <span className="rc-k">{desk.company.name}</span>
          <span className="rc-mine-v"><span className={chip.cls}>{chip.label}</span> <span className="rc-sum">{mine.summary}</span></span>
        </div>
      )}
      <div className="meta">
        <span className="rc-lock">{lock.short}</span>
        <span>{lock.rest || 'Pre-registered before scoring'}</span>
      </div>
    </article>
  );
}

/** Header: today's decisions that fired (non-zero), else the first count ("0 fired today"). Config and watchlist sizes aren't fires. */
function HeadCount({ rule }: { rule: RuleCard }) {
  const fires = rule.counts.filter((c) => !/configured|watchlist/i.test(c.label));
  const hits = fires.filter((c) => c.value > 0);
  const show = hits.length ? hits : fires.slice(0, 1);
  if (!show.length) return null;
  return (
    <span className="rc-head">
      {show.map((c, i) => <span key={c.label}>{i > 0 && ' + '}<b data-num>{fmtInt(c.value)}</b> {c.label}</span>)} today
    </span>
  );
}

// ---------------------------------------------------------------- example chains (real records only)

function O1Chain({ desk }: { desk: CompanyDesk }) {
  const o = desk.openings.find((x) => x.status === 'open') ?? desk.openings.find((x) => x.status === 'watch');
  if (!o) return null;
  const dep = o.clauses?.find((c) => c.id === 'o1.departures');
  const repl = o.clauses?.filter((c) => c.id.startsWith('o1.no_replacement')) ?? [];
  const n = dep?.text.match(/^(\d+)/)?.[1];
  const months = clauseMonths(dep);
  const noRepl = repl.length > 0 && repl.every((c) => c.state === 'met');
  return (
    <div className="chain" aria-label="Example from today">
      <span className="n">{desk.company.name}</span>
      {n && <button className="e linkish-e" onClick={() => dep?.evidenceIds[0] && openEvidence(dep.evidenceIds[0])}>{n} left{months ? ` (${months})` : ''}</button>}
      {repl.length > 0 && <button className="e linkish-e" onClick={() => repl[0].evidenceIds[0] && openEvidence(repl[0].evidenceIds[0])}>{noRepl ? '0 replacements' : 'replacement found'}</button>}
      <span className={`n ${o.windowClosesBy ? 'prov' : ''}`}>{familyShort(o.roleFamily)} opening{o.windowClosesBy ? ', provisional' : ''}</span>
    </div>
  );
}

function R1Chain({ desk, rule }: { desk: CompanyDesk; rule?: DossierRule }) {
  const fam = desk.openings[0]?.roleFamily ?? desk.departures[0]?.roleFamily ?? null;
  const deps = desk.departures.filter((d) => !fam || d.roleFamily === fam);
  if (!deps.length) return null;
  const detail = rule?.clauses[0]?.detail;
  const seen = new Set<string>();
  const dests = deps.filter((d) => d.toCompanyName && !seen.has(d.toCompanyName) && !!seen.add(d.toCompanyName));
  return (
    <div className="chain" aria-label="Example from today">
      <span className="n">{desk.company.name}</span>
      <span className="e">loses {familyShort(fam)} to</span>
      {dests.map((d) => {
        const why = notConclusive(detail, d.toCompanyName);
        return (
          <button key={d.id} className={`n btn-n ${why ? 'struck-n' : ''}`} title={why ? `Not conclusive: ${why}` : `${d.initial} ${d.role}`}
            onClick={() => openEvidence(d.evidenceId)}>{d.toCompanyName}</button>
        );
      })}
    </div>
  );
}

const PATTERNS: Record<string, string[]> = {
  CONTAGION: ['Peer of B', 'dated infra move', 'B, same profile', 'no infra hiring yet'],
  DISPLACEMENT: ['Provider', 'acquired, shut or repriced', 'Company naming it in a job post', 'must migrate'],
  DIRECT: ['Company', 'posts 2+ serving roles', 'Needs serving now'],
};
function PatternChain({ id }: { id: string }) {
  const p = PATTERNS[id];
  if (!p) return null;
  return (
    <div className="chain" aria-label="Rule shape, no records">
      <span className="rc-k">Shape</span>
      {p.map((t, i) => <span key={t} className={i % 2 === 0 ? 'n pattern' : 'e'}>{t}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------- watchlist (R1 at 2 of 3 for this company)

function WatchCard({ desk, dossier, loading }: { desk: CompanyDesk; dossier: CompanyDossier | null; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const r1 = dossier?.rules.find((r) => r.id === 'R1');
  const w = watchCount(r1);
  if (!w) return loading ? <div className="rule-card ghost" aria-hidden /> : null;
  if (desk.openings.some((o) => o.status === 'held')) return null; // O1 held (e.g. acqui-hire): no watchlist count for this company
  const o1dep = desk.openings.flatMap((o) => o.clauses ?? []).find((c) => c.id === 'o1.departures');
  const months = clauseMonths(o1dep);
  const fam = desk.openings[0]?.roleFamily ?? null;
  const conclusive = desk.departures.filter((d) => (!fam || d.roleFamily === fam) && !notConclusive(w.clause.detail, d.toCompanyName));
  const ev = evidenceMap(desk.evidence, dossier?.evidence);
  const rows = w.clause.evidenceIds.map((id) => ev.get(id)).filter((e) => !!e);
  const next = w.need - w.have;
  const fires = next === 1 ? `${w.have} of ${w.need} · needs 1 more qualifying departure` : `${w.have} of ${w.need}`;
  return (
    <article className="rule-card watch" data-testid="rule-watchlist">
      <div className="id">
        <span className="rid">Watchlist · R1</span>
        <span className="st prov">{fires}</span>
      </div>
      <h3>{desk.company.name}, {familyShort(fam)}</h3>
      <div className="watch-row">
        <div className="pips" data-testid="watch-pips" aria-label={fires}>
          {Array.from({ length: w.need }, (_, i) => <i key={i} className={i < w.have ? 'f' : i === w.have ? 'next' : ''} />)}
        </div>
        <span className="watch-text">
          {plural(w.have, 'conclusive departure')}
          {conclusive.length > 0 && <> (to {conclusive.map((d) => d.toCompanyName).join(', to ')})</>}
          {months && <>, {months}</>}. {next === 1 ? `A ${ordinal(w.need)} inside the last 30 days fires R1, if no guard matches.` : `${next} more inside 90 days fire R1, if no guard matches.`}
        </span>
      </div>
      {w.clause.detail && <p className="rc-detail">{w.clause.detail}</p>}
      {open && (
        <ul className="rc-rows">
          {rows.map((e) => (
            <li key={e.id}><button className="srclink mono" onClick={() => openEvidence(e.id)}>{evDate(e)}</button><span>{e.claim}</span></li>
          ))}
        </ul>
      )}
      <div className="meta">
        <span>Checked {dossier?.asOf ? fmtDate(dossier.asOf, true) : 'today'} · openings scan</span>
        {rows.length > 0 && <button className="count" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{plural(rows.length, 'record')}</button>}
        {dossier && <span className="mono" title={dossier.runId}>{dossier.runId.slice(0, 12)}</span>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- guards

function GuardsCard({ o1, held }: { o1: RuleCard; held: ReturnType<typeof useHeldExample> }) {
  const heldCount = o1.counts.find((c) => /^held/i.test(c.label));
  const o: Opening | null = held.opening;
  const g = o ? guardClause(o) : undefined;
  const ev = evidenceMap(held.evidence);
  const src = g?.evidenceIds.map((id) => ev.get(id)).find(Boolean);
  return (
    <article className="rule-card" data-testid="rule-GUARDS">
      <div className="id">
        <span className="rid">Guards · O1, R1</span>
        <span className="rc-lock">{lockParts(o1.lockedAt).short}</span>
      </div>
      <h3>False-drain guards</h3>
      <p className="def">Any guard that matches puts the decision on Hold, whatever the departure pattern says.</p>
      <ul className="thr guards">{o1.guards.map((t) => <li key={t}>{t}</li>)}</ul>
      {o && g && (
        <div className="chain" aria-label="Example from today">
          <span className="n">{o.companyName}</span>
          <span className="e">departures met</span>
          <button className="e linkish-e" onClick={() => src && openEvidence(src.id)}>{guardLabel(g.id)} guard{src ? `, ${evDate(src)}` : ''}</button>
          <span className="n held">Held</span>
        </div>
      )}
      <div className="rc-today">
        <span className="rc-k">Today</span>
        <span className="rc-counts">{heldCount ? <span><b data-num>{fmtInt(heldCount.value)}</b> O1 {heldCount.label}</span> : <span className="faint">no held count reported</span>}</span>
      </div>
      <div className="meta"><span>Shared by O1 and R1; checked before any decision is shown</span></div>
    </article>
  );
}
