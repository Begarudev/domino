// Candidate dashboard: openings for this candidate as rule O1 decisions (clause chips that open their date math and
// source rows; no scores), why they fit field by field, Request intro with a field-level preview and a consent tick,
// the candidate's own requests, and delivered intros with their receipts.
import { useEffect, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import { isMonthLevel, openingLabel, ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import type { Opening } from '../../data/desk.ts';
import { deskApi, invalidate, useQuery } from '../../data/query.ts';
import { href, navigate } from '../../data/router.ts';
import { daysBetween, fmtDate, fmtInt, fmtTime, plural } from '../../lib/format.ts';
import { reducedMotion, useEnterOnce } from '../../lib/motion.ts';
import { SourceNote } from '../../shell/SourceNote.tsx';
import { openEvidence } from '../../shell/ui.ts';
import { introPreview, myIntros } from '../onboarding/contract.ts';
import type { CandidateX, IntroPreview, IntroX, OpeningX, RuleClause } from '../onboarding/contract.ts';
import { findEvidence, sourceName } from '../onboarding/shared.ts';
import type { RoleFamily } from '../../data/desk.ts';
import { CheckedStrip, HowItWorks, NeverEmpty } from './Explainer.tsx';
import { useScan } from './scan.tsx';
import './dashboard.css';

/** Demo and screenshot override: ?family=backend_payments renders the dashboard for that role family. */
const familyParam = (): RoleFamily | null => {
  const v = new URLSearchParams(location.search).get('family');
  return v && v in ROLE_FAMILY_LABELS ? (v as RoleFamily) : null;
};

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** '2026-10' -> '2026-10-31'; a full date stays as it is. */
const lastDay = (d: string) => (d.length === 7 ? new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10) : d.slice(0, 10));
const ENTER_MS = 200;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Fit lines arrive with ISO months ("since 2023-03") and a "(month precision)" aside; show "Mar 2023" and let a chip carry the precision. */
const fitText = (t: string) => t
  .replace(/ \(\d{4}-\d{2}-\d{2}\)$/, '')
  .replace(/ \(month precision\)/g, '')
  .replace(/\b(\d{4})-(\d{2})\b(?!-)/g, (m, y: string, mo: string) => (MONTHS[+mo - 1] ? `${MONTHS[+mo - 1]} ${y}` : m));

export function CandidateDashboard({ candidateId }: { candidateId: string }) {
  const cand = useQuery(`cand:${candidateId}`, () => deskApi.candidate(candidateId));
  const openings = useQuery(`cand-openings:${candidateId}`, () => deskApi.candidateOpenings(candidateId));
  const inbox = useQuery(`cand-inbox:${candidateId}`, () => deskApi.candidateInbox(candidateId));
  const mineQ = useQuery(`cand-intros:${candidateId}`, () => myIntros(candidateId));
  const scan = useScan();
  const c = cand.data as CandidateX | null;
  const family = familyParam() ?? c?.roleFamily ?? null;
  const list = ((openings.data ?? []) as OpeningX[]).filter((o) => !familyParam() || o.roleFamily === family);
  const topCompany = list.find((o) => o.status === 'open')?.companyId ?? null;
  const desk = useQuery(topCompany ? `cand-desk:${topCompany}` : null, () => deskApi.company(topCompany!));
  const moves = desk.data?.funnel?.find((f) => /job moves/i.test(f.label))?.count ?? null;
  const ranked = [...list].sort((a, b) => rank(a) - rank(b));
  const mine = mineQ.data ?? [];
  // Delivered company-to-candidate intros only, each with its receipt from the send-once outbox.
  const delivered = ((inbox.data ?? []) as IntroX[]).filter((r) => r.direction === 'company_to_candidate' && r.status === 'delivered');

  return (
    <div className="page dash">
      <header className="dash-head">
        <div className="dash-hi">
          <h1 className="dash-name">{c ? `Hi ${c.displayName}` : <span className="ghost" style={{ width: 260, height: 44 }} />}</h1>
          {c?.fixture && <span className="tag warn">Fictional demo candidate</span>}
        </div>
        <p className="dash-sub">
          {family ? ROLE_FAMILY_LABELS[family] : 'Role family not set'}
          <a className="dash-edit" href={href({ page: 'candidate', sub: 'onboard' })} onClick={(e) => { e.preventDefault(); navigate({ page: 'candidate', sub: 'onboard' }); }}>
            Edit what you share
          </a>
        </p>
      </header>

      <HowItWorks />
      <CheckedStrip scan={scan} />

      <section className="dash-sec" aria-labelledby="dash-open-h">
        <div className="dash-sec-head">
          <h2 id="dash-open-h" className="dash-h2">Openings for you</h2>
          {openings.data && (
            <p className="dash-topline">
              {moves != null ? `From ${fmtInt(moves)} job moves read: ` : ''}{topLine(list)}. Rule O1 over dated Crustdata records
              {list[0] ? `, checked ${fmtDate(list[0].predictedAt)}` : ''}.
            </p>
          )}
        </div>
        <SourceNote source={openings.source} error={openings.error} />
        {openings.loading && !openings.data && <div className="op-ghost surface"><span className="ghost" style={{ width: '40%', height: 34 }} /><span className="ghost" style={{ width: '80%', height: 40 }} /></div>}
        {openings.data && !list.length && (
          <NeverEmpty scan={scan} cand={c} family={family}
            renderCard={(o, ev) => <OpeningCard o={o} cand={c} evidence={ev} mine={mine} candidateId={candidateId} compact />} />
        )}
        <div className="op-list">
          {ranked.map((o) => (
            <OpeningCard key={o.id} o={o} cand={c} evidence={openings.evidence} mine={mine} candidateId={candidateId} />
          ))}
        </div>
      </section>

      {mine.length > 0 && (
        <section className="dash-sec" aria-labelledby="dash-mine-h">
          <h2 id="dash-mine-h" className="dash-h2">Your intro requests</h2>
          <ol className="inbox">{mine.map((r) => <IntroRow key={r.id} r={r} mine />)}</ol>
        </section>
      )}

      <section className="dash-sec" aria-labelledby="dash-inbox-h" data-testid="inbox">
        <h2 id="dash-inbox-h" className="dash-h2">Intro requests to you</h2>
        <SourceNote source={null} error={inbox.error} />
        {delivered.length ? (
          <ol className="inbox">{delivered.map((r) => <IntroRow key={r.id} r={r} />)}</ol>
        ) : (
          <p className="dash-quiet">None yet. A request appears here once it’s delivered, with its receipt.</p>
        )}
      </section>
    </div>
  );
}

function topLine(list: Opening[]): string {
  const n = (l: string) => list.filter((o) => openingLabel(o) === l).length;
  const parts = [
    n('open') ? plural(n('open'), 'predicted opening') : '',
    n('provisional') ? plural(n('provisional'), 'provisional opening') : '',
    n('watch') ? `${fmtInt(n('watch'))} on watch` : '',
    n('held') ? `${fmtInt(n('held'))} held` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No openings for your role family yet';
}

const rank = (o: Opening) => ({ open: 0, provisional: 0, watch: 1, held: 2 })[openingLabel(o)];

/** Rule-language headline: "O1 · Provisional · window through 30 Nov", "Held · acqui-hire guard · thenextweb.com, 21 Aug". */
function headline(o: Opening, evidence: Evidence[]): string {
  const label = openingLabel(o);
  if (label === 'held') {
    const guard = (o.holdReasons?.[0] ?? 'false-drain guard').split(':')[0].trim().toLowerCase();
    const ev = findEvidence(evidence, o.reasons.find((r) => r.kind === 'news')?.evidenceId);
    return ['Held', guard.endsWith('guard') ? guard : `${guard} guard`, ev ? `${sourceName(ev)}, ${fmtDate(ev.observedAt)}` : ''].filter(Boolean).join(' · ');
  }
  if (label === 'provisional') return `O1 · Provisional · window through ${fmtDate(o.windowClosesBy)}`;
  if (label === 'watch') return `O1 · Watch${o.watch ? ` · ${o.watch.have} of ${o.watch.need} clauses met` : ''}`;
  return 'O1 · Predicted opening';
}

const STATE_TEXT = { held: 'Held', provisional: 'Provisional', watch: 'Watch', open: 'Predicted opening' } as const;
/** Rule and state as shared meaning chips (rule O1 blue, provisional, watch, held), then the rest of the headline as text. */
function OpRule({ o, held, evidence }: { o: Opening; held: boolean; evidence: Evidence[] }) {
  const label = held ? 'held' : openingLabel(o);
  const rest = headline(o, evidence).replace(/^(O1 · )?(Held|Provisional|Watch|Predicted opening)( · )?/, '');
  return (
    <p className={`op-rule ${label}`} data-num>
      <span className="ctag rule-o1">O1</span>
      <span className={`ctag tone-${label}`}>{STATE_TEXT[label]}</span>
      {rest && <span className="op-rule-rest">{rest}</span>}
    </p>
  );
}

/** The engine's clauses; for a fixture opening without them, derived from its dated reasons (never a score). */
function clausesOf(o: OpeningX, evidence: Evidence[]): RuleClause[] {
  if (o.clauses?.length) return o.clauses;
  const ids = (endpoint: string) => o.evidenceIds.filter((id) => findEvidence(evidence, id)?.source.endpoint === endpoint);
  const out: RuleClause[] = [];
  const sorted = [...o.reasons].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  for (const r of sorted) {
    const ev = findEvidence(evidence, r.evidenceId);
    if (r.kind === 'talent_drain') {
      const rows = ids('person_recent_moves');
      out.push({ id: 'o1.departures', text: r.label, state: 'met', evidenceIds: rows.length ? rows : r.evidenceId ? [r.evidenceId] : [],
        detail: `${plural(rows.length || 1, 'dated departure')} in ${fmtDate(r.date, true)}${isMonthLevel(r.date) ? ' (month-level dates)' : ''}, inside the 90-day window ${fmtDate(addDays(o.predictedAt, -90), true)} to ${fmtDate(o.predictedAt, true)}.` });
    } else if (r.kind === 'no_replacement') {
      out.push({ id: 'o1.no_replacement', text: r.label, state: 'met', evidenceIds: r.evidenceId ? [r.evidenceId] : [],
        detail: ev ? `${ev.claim}. ${ev.value != null ? `${ev.value} records returned. ` : ''}${sourceName(ev)}, checked ${fmtDate(ev.observedAt, true)}.` : undefined });
    } else if (r.kind === 'news' && o.status === 'held') {
      out.push({ id: 'guard.acquihire', text: 'Acqui-hire guard matched', state: 'failed', evidenceIds: r.evidenceId ? [r.evidenceId] : [],
        detail: ev ? `“${ev.claim}”, ${sourceName(ev)}, ${fmtDate(ev.observedAt, true)}. The departures moved with a deal, so they don’t count as a drain.` : undefined });
    } else if (r.kind === 'headcount') {
      out.push({ id: 'o1.size', text: r.label, state: 'met', evidenceIds: r.evidenceId ? [r.evidenceId] : [], detail: ev ? `${ev.claim}, ${fmtDate(ev.observedAt, true)}.` : undefined });
    }
  }
  if (o.status === 'open' && o.windowClosesBy) {
    const days = daysBetween(today(), o.windowClosesBy);
    const last = o.reasons.find((r) => r.kind === 'talent_drain')?.date;
    const from = last ? lastDay(last) : null;
    // Show the sum only when it reproduces the engine's date; otherwise state the engine's date alone.
    const sum = from && addDays(from, 30) === o.windowClosesBy ? ` ${fmtDate(from)} + 30 days = ${fmtDate(o.windowClosesBy, true)}.` : '';
    out.push({ id: 'o1.window', text: `Window open through ${fmtDate(o.windowClosesBy)}`, state: 'open', evidenceIds: [],
      detail: `As of ${fmtDate(o.predictedAt, true)}: latest departure ${fmtDate(last, true)}${isMonthLevel(last) ? `, a month-level date, so counted from its last day (${fmtDate(from)})` : ''}.${sum} No replacement hire or post by then confirms the opening${days >= 0 ? `; ${plural(days, 'day')} left` : ''}.` });
  }
  return out;
}

const MARK: Record<RuleClause['state'], string> = { met: '✓', open: '', failed: '✗', cant_verify: '?' };
const STATE_WORD: Record<RuleClause['state'], string> = { met: 'met', open: 'still open', failed: 'failed', cant_verify: 'I can’t verify' };

function OpeningCard({ o, cand, evidence, mine, candidateId, compact }: {
  o: OpeningX; cand: CandidateX | null; evidence: Evidence[]; mine: IntroX[]; candidateId: string; compact?: boolean;
}) {
  const held = openingLabel(o) === 'held';
  const clauses = clausesOf(o, evidence);
  const [openClause, setOpenClause] = useState<string | null>(null);
  const shown = clauses.find((cl) => cl.id === openClause) ?? null;
  return (
    <article className={`op surface ${held ? 'is-held' : ''} ${compact ? 'compact' : ''}`} data-testid={`opening-${o.id}`}>
      <div className="op-head">
        <div className="op-title">
          <h3 className="op-co">{o.companyName}</h3>
          <span className="op-role">{o.roleTitle}</span>
        </div>
        <OpRule o={o} held={held} evidence={evidence} />
      </div>

      <ol className="clauses" aria-label="Rule O1 clauses">
        {clauses.map((cl) => (
          <li key={cl.id}>
            <button type="button" className={`clause s-${cl.state}`} data-testid="reason-chip" aria-expanded={openClause === cl.id}
              onClick={() => setOpenClause((cur) => (cur === cl.id ? null : cl.id))}>
              <span className="clause-mark" aria-hidden="true">{MARK[cl.state]}</span>
              <span className="clause-text">{cl.text}</span>
              <span className="clause-chev" aria-hidden="true" />
              <span className="sr-only">, {STATE_WORD[cl.state]}</span>
            </button>
          </li>
        ))}
      </ol>
      {shown && <ClauseDetail key={shown.id} cl={shown} evidence={evidence} />}

      {!held && (
        <>
          {o.fit && o.fit.length > 0 && (
            <div className="fit">
              <h4 className="fit-h">Why you fit</h4>
              <ul className="fit-list">
                {o.fit.map((f) => (
                  <li key={f.text} className={f.status === 'verified' ? 'ok' : 'cant'}>
                    <span className="fit-mark" aria-hidden="true">{f.status === 'verified' ? '✓' : '?'}</span>
                    <span className="fit-text">{fitText(f.text)}</span>
                    {/\(month precision\)/.test(f.text) && <span className="tag">month-level</span>}
                    {f.status === 'cant_verify' && <span className="ctag tone-cant-verify">I can’t verify</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {o.watch?.reason && <p className="op-watch">{o.watch.reason}</p>}
          {o.status === 'open' && !compact && <IntroAction o={o} cand={cand} mine={mine} candidateId={candidateId} />}
        </>
      )}
    </article>
  );
}

function ClauseDetail({ cl, evidence }: { cl: RuleClause; evidence: Evidence[] }) {
  const ref = useEnterOnce<HTMLDivElement>(false, undefined, ENTER_MS);
  return (
    <div className={`clause-detail s-${cl.state}`} ref={ref}>
      <p className="clause-detail-text">{cl.detail ?? cl.text}</p>
      {cl.evidenceIds.length > 0 && (
        <ul className="clause-rows">
          {cl.evidenceIds.map((id) => {
            const ev = findEvidence(evidence, id);
            return (
              <li key={id}>
                <button type="button" className="clause-row" onClick={() => openEvidence(id)}>
                  <span className="clause-row-date" data-num>
                    {ev ? fmtDate(ev.observedAt, true) : 'Source'}
                    {ev && isMonthLevel(ev.observedAt) && <span className="tag">month-level date</span>}
                  </span>
                  <span className="clause-row-claim">{ev?.claim ?? `Record ${id}`}</span>
                  <span className="clause-row-src">{ev ? sourceName(ev) : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IntroAction({ o, cand, mine, candidateId }: { o: Opening; cand: CandidateX | null; mine: IntroX[]; candidateId: string }) {
  const existing = mine.find((r) => r.openingId === o.id) ?? null;
  const [preview, setPreview] = useState<IntroPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (!cand) return;
    setLoading(true);
    setError(null);
    try { setPreview(await introPreview(cand, o)); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await deskApi.requestIntro(candidateId, o.id);
      setPreview(null);
      invalidate(`cand-intros:${candidateId}`);
      invalidate(`cand-inbox:${candidateId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (existing) {
    return (
      <div className="intro">
        <button type="button" className="btn intro-done" data-testid={`request-intro-${o.id}`}
          onClick={() => setNote(`Already requested on ${fmtDate(existing.receivedAt)}, ${fmtTime(existing.receivedAt)}. It’s under Your intro requests.`)}>
          <span aria-hidden="true">✓</span> Intro requested, {STATUS[existing.status].text.toLowerCase()}
        </button>
        {note && <span className="intro-note" role="status">{note}</span>}
      </div>
    );
  }
  return (
    <div className="intro">
      {!preview ? (
        <button type="button" className="btn primary" data-testid={`request-intro-${o.id}`} disabled={loading || !cand} onClick={() => void open()}>
          {loading ? 'Preparing preview' : 'Request intro'}
        </button>
      ) : (
        <IntroConfirm p={preview} busy={busy} onSend={() => void send()} onCancel={() => { setPreview(null); setError(null); }} />
      )}
      {error && <span className="intro-err" role="alert">Couldn’t request it: {error}</span>}
    </div>
  );
}

function IntroConfirm({ p, busy, onSend, onCancel }: { p: IntroPreview; busy: boolean; onSend: () => void; onCancel: () => void }) {
  const ref = useEnterOnce<HTMLDivElement>(false, undefined, ENTER_MS);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); }, [ref]);
  return (
    <div className="intro-confirm" ref={ref}>
      <div className="intro-cols">
        <div>
          <h4 className="intro-h">{p.companyName} will see</h4>
          <dl className="intro-fields">
            {p.shared.map((f) => <div key={f.field}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
          </dl>
        </div>
        <div>
          <h4 className="intro-h">Not shared</h4>
          <dl className="intro-fields withheld">
            {p.withheld.map((f) => <div key={f.field}><dt>{f.label}</dt><dd>{f.reason}</dd></div>)}
          </dl>
        </div>
      </div>
      <label className="consent-item intro-agree">
        <input data-testid="intro-consent" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span className="consent-box" aria-hidden="true" />
        <span className="consent-text"><b>Share these fields with {p.companyName} for this intro</b></span>
      </label>
      <div className="intro-btns">
        <button type="button" className="btn primary" data-testid="intro-confirm" disabled={busy || !agreed} onClick={onSend}>{busy ? 'Requesting' : 'Request intro'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

const STATUS: Record<IntroX['status'], { text: string; cls: string }> = {
  new: { text: 'New', cls: 'tone-open' },
  awaiting_approval: { text: 'Awaiting approval', cls: 'tone-watch' },
  not_drafted: { text: 'Not drafted: not enough verified evidence', cls: 'tone-cant-verify' },
  accepted: { text: 'Accepted', cls: 'tone-met' },
  declined: { text: 'Declined', cls: 'tone-not-met' },
  delivered: { text: 'Delivered', cls: 'tone-delivered' },
};

function IntroRow({ r, mine }: { r: IntroX; mine?: boolean }) {
  const ref = useEnterOnce<HTMLLIElement>(false, undefined, ENTER_MS);
  const s = STATUS[r.status];
  return (
    <li className="inbox-row surface" ref={ref}>
      <div className="inbox-top">
        <b className="inbox-co">{r.companyName}</b>
        <span className="inbox-role">{r.roleTitle}</span>
        <span className={`ctag ${s.cls}`}>{s.text}</span>
        <span className="inbox-date" data-num>{mine ? 'You asked' : 'Received'} {fmtDate(r.receivedAt)}, {fmtTime(r.receivedAt)}</span>
      </div>
      {!mine && <div className="inbox-msg">{r.message.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}</div>}
      {r.receipt && (
        <p className="inbox-receipt" data-num>Receipt {r.receipt.idempotencyKey.slice(0, 8)}, delivered {fmtDate(r.receipt.receivedAt)}, {fmtTime(r.receipt.receivedAt)}</p>
      )}
    </li>
  );
}
