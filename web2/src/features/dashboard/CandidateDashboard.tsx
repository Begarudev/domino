// Candidate dashboard: companies likely hiring for this candidate (rule O1 over dated records, each claim a dated
// chip that opens its source), why they fit, "Request intro" with a consent confirm, and the inbox.
import { useEffect, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import { isMonthLevel, openingLabel, ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import type { Candidate, IntroRequest, Opening, OpeningReason } from '../../data/desk.ts';
import { deskApi, invalidate, useQuery } from '../../data/query.ts';
import { href, navigate } from '../../data/router.ts';
import { daysBetween, fmtDate, fmtInt, fmtPct, fmtTime, plural } from '../../lib/format.ts';
import { reducedMotion, useEnterOnce } from '../../lib/motion.ts';
import { SourceNote } from '../../shell/SourceNote.tsx';
import { openEvidence } from '../../shell/ui.ts';
import { findEvidence, joinList, sharedFields, sourceName } from '../onboarding/shared.ts';
import './dashboard.css';

const today = () => new Date().toISOString().slice(0, 10);

export function CandidateDashboard({ candidateId }: { candidateId: string }) {
  const cand = useQuery(`cand:${candidateId}`, () => deskApi.candidate(candidateId));
  const openings = useQuery(`cand-openings:${candidateId}`, () => deskApi.candidateOpenings(candidateId));
  const inbox = useQuery(`cand-inbox:${candidateId}`, () => deskApi.candidateInbox(candidateId));
  const list = openings.data ?? [];
  const fits = list.filter((o) => o.status === 'open');
  // The funnel counts live on the company desk of the top opening; if it isn't there, the top line leaves them out.
  const topCompany = fits[0]?.companyId ?? null;
  const desk = useQuery(topCompany ? `cand-desk:${topCompany}` : null, () => deskApi.company(topCompany!));
  const moves = desk.data?.funnel?.find((f) => /job moves/i.test(f.label))?.count ?? null;
  const c = cand.data;
  const ranked = [...list].sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);

  return (
    <div className="page dash">
      <header className="dash-head">
        <div className="dash-hi">
          <h1 className="dash-name">{c ? `Hi ${c.displayName}` : <span className="ghost" style={{ width: 260, height: 44 }} />}</h1>
          {c?.fixture && <span className="tag warn">Fictional demo candidate</span>}
        </div>
        <p className="dash-sub">
          {c?.roleFamily ? ROLE_FAMILY_LABELS[c.roleFamily] : 'Role family not read yet'}
          <a className="dash-edit" href={href({ page: 'candidate', sub: 'onboard' })} onClick={(e) => { e.preventDefault(); navigate({ page: 'candidate', sub: 'onboard' }); }}>
            Edit what you share
          </a>
        </p>
      </header>

      <section className="dash-sec" aria-labelledby="dash-open-h">
        <div className="dash-sec-head">
          <h2 id="dash-open-h" className="dash-h2">Companies likely hiring for you</h2>
          {openings.data && (
            <p className="dash-topline" data-num>
              {moves != null ? `From ${fmtInt(moves)} job moves read, ` : ''}
              {fits.length === 1 ? '1 opening fits you' : `${fmtInt(fits.length)} openings fit you`}
              {list.length > fits.length ? `, ${plural(list.length - fits.length, 'more')} on hold or watch` : ''}.
              {' '}Predicted by rule O1 over dated Crustdata records{list[0] ? `, checked ${fmtDate(list[0].predictedAt)}` : ''}.
            </p>
          )}
        </div>
        <SourceNote source={openings.source} error={openings.error} />
        {openings.loading && !openings.data && <div className="op-ghost surface"><span className="ghost" style={{ width: '40%', height: 34 }} /><span className="ghost" style={{ width: '80%', height: 40 }} /></div>}
        {openings.data && !list.length && (
          <p className="dash-empty surface">No company in today’s scan has lost two people in your role family without replacing them. DOMINO rescans as new job moves arrive.</p>
        )}
        <div className="op-list">
          {ranked.map((o) => (
            <OpeningCard key={o.id} o={o} cand={c} evidence={openings.evidence} intros={inbox.data ?? []} candidateId={candidateId} />
          ))}
        </div>
      </section>

      <section className="dash-sec" aria-labelledby="dash-inbox-h" data-testid="inbox">
        <h2 id="dash-inbox-h" className="dash-h2">Companies reaching out</h2>
        {/* the fixture label already sits above the openings; here only a failure needs saying */}
        <SourceNote source={inbox.source === openings.source ? null : inbox.source} error={inbox.error} />
        <Inbox items={inbox.data ?? []} />
      </section>
    </div>
  );
}

const rank = (o: Opening) => ({ open: 0, provisional: 0, watch: 1, held: 2 })[openingLabel(o)];

function OpeningCard({ o, cand, evidence, intros, candidateId }: {
  o: Opening; cand: Candidate | null; evidence: Evidence[]; intros: IntroRequest[]; candidateId: string;
}) {
  const label = openingLabel(o);
  const held = label === 'held';
  const days = o.windowClosesBy ? daysBetween(today(), o.windowClosesBy) : null;
  return (
    <article className={`op surface ${held ? 'is-held' : ''}`} data-testid={`opening-${o.id}`}>
      <div className="op-head">
        <div className="op-title">
          <h3 className="op-co">{o.companyName}</h3>
          <span className="op-role">{o.roleTitle}</span>
        </div>
        <div className="op-status">
          {label === 'open' && <span className="tag live">Predicted opening</span>}
          {label === 'provisional' && <span className="tag live">Predicted opening (provisional)</span>}
          {label === 'watch' && <span className="tag">Watch{o.watch ? `: ${o.watch.have} of ${o.watch.need} signals` : ''}</span>}
          {held && <span className="tag warn">Held: not an opening</span>}
          <span className="op-conf" data-num title="Rule O1: 2+ dated departures in one role family within 90 days, and no dated replacement hire or job post within 30 days of the last one.">
            {held ? 'O1, held' : `O1, ${fmtPct(o.confidence)}`}
          </span>
        </div>
      </div>

      <Proof o={o} evidence={evidence} days={days} />

      {held ? (
        <HeldNote o={o} evidence={evidence} />
      ) : (
        <>
          {o.fit && o.fit.length > 0 && (
            <div className="fit">
              <h4 className="fit-h">Why you fit</h4>
              <ul className="fit-list">
                {o.fit.map((f) => (
                  <li key={f.text} className={f.status === 'verified' ? 'ok' : 'cant'}>
                    <span className="fit-mark" aria-hidden="true">{f.status === 'verified' ? '✓' : '?'}</span>
                    <span className="fit-text">{f.text}</span>
                    {f.status === 'cant_verify' && <span className="tag warn">I can’t verify</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {o.watch?.reason && <p className="op-watch">{o.watch.reason}</p>}
          {o.status === 'open' && <IntroAction o={o} cand={cand} intros={intros} candidateId={candidateId} />}
        </>
      )}
    </article>
  );
}

/** The dated reason chips, left to right, as a small proof timeline. Each chip opens its source. */
function Proof({ o, evidence, days }: { o: Opening; evidence: Evidence[]; days: number | null }) {
  const steps = o.reasons.filter((r) => r.kind === 'talent_drain' || r.kind === 'no_replacement' || r.kind === 'news');
  const rest = o.reasons.filter((r) => !steps.includes(r));
  return (
    <div className="proof">
      <ol className="proof-line">
        {steps.map((r) => <ReasonChip key={`${r.kind}-${r.label}`} r={r} evidence={evidence} />)}
        {o.windowClosesBy && o.status === 'open' && (
          <li className="proof-step is-end">
            <div className="proof-chip proof-end">
              <span className="proof-date" data-num>Window closes {fmtDate(o.windowClosesBy)}{days != null && days >= 0 ? `, ${plural(days, 'day')} left` : ''}</span>
              <span className="proof-claim">Still no replacement by then confirms the opening</span>
              <span className="proof-src">Rule O1, 30 days after the last departure</span>
            </div>
          </li>
        )}
      </ol>
      {rest.length > 0 && (
        <p className="proof-also">
          {rest.map((r) => (
            <button key={r.label} type="button" className="proof-also-item" data-testid="reason-chip" onClick={() => r.evidenceId && openEvidence(r.evidenceId)} disabled={!r.evidenceId}>
              {r.label}, {fmtDate(r.date, true)}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function ReasonChip({ r, evidence }: { r: OpeningReason; evidence: Evidence[] }) {
  const ev = findEvidence(evidence, r.evidenceId);
  const checked = r.kind === 'no_replacement';
  return (
    <li className={`proof-step k-${r.kind}`}>
      <button type="button" className="proof-chip" data-testid="reason-chip" disabled={!r.evidenceId} onClick={() => r.evidenceId && openEvidence(r.evidenceId)}>
        <span className="proof-date" data-num>
          {checked ? `Checked ${fmtDate(r.date, true)}` : fmtDate(r.date, true)}
          {isMonthLevel(r.date) && <span className="tag">month-level date</span>}
        </span>
        <span className="proof-claim">{r.label}</span>
        <span className="proof-src">{ev ? sourceName(ev) : 'Source'}, open the record</span>
      </button>
    </li>
  );
}

/** A held opening says why, with its dated source in plain view: the trust beat. */
function HeldNote({ o, evidence }: { o: Opening; evidence: Evidence[] }) {
  const news = o.reasons.find((r) => r.kind === 'news');
  const ev = findEvidence(evidence, news?.evidenceId);
  return (
    <div className="held">
      <p className="held-why">{(o.holdReasons ?? ['A false-drain guard fired']).join('. ')}. DOMINO doesn’t count this as an opening, so it doesn’t suggest an intro.</p>
      {ev && (
        <p className="held-src">
          “{ev.claim}”, <span data-num>{sourceName(ev)}, {fmtDate(ev.observedAt, true)}</span>
        </p>
      )}
    </div>
  );
}

function IntroAction({ o, cand, intros, candidateId }: { o: Opening; cand: Candidate | null; intros: IntroRequest[]; candidateId: string }) {
  const existing = intros.find((r) => r.openingId === o.id && r.direction === 'candidate_to_company') ?? null;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shares = cand ? joinList(sharedFields(cand.consent)) : 'what you agreed to share';

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await deskApi.requestIntro(candidateId, o.id);
      setAsking(false);
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
          onClick={() => setNote(`Already requested on ${fmtDate(existing.receivedAt)}, ${fmtTime(existing.receivedAt)}. It’s in your inbox below.`)}>
          <span aria-hidden="true">✓</span> Intro requested
        </button>
        {note && <span className="intro-note" role="status">{note}</span>}
      </div>
    );
  }
  return (
    <div className="intro">
      {!asking ? (
        <button type="button" className="btn primary" data-testid={`request-intro-${o.id}`} onClick={() => setAsking(true)}>Request intro</button>
      ) : (
        <IntroConfirm company={o.companyName} shares={shares} busy={busy} onSend={() => void send()} onCancel={() => { setAsking(false); setError(null); }} />
      )}
      {error && <span className="intro-err" role="alert">Couldn’t request it: {error}</span>}
    </div>
  );
}

function IntroConfirm({ company, shares, busy, onSend, onCancel }: { company: string; shares: string; busy: boolean; onSend: () => void; onCancel: () => void }) {
  const ref = useEnterOnce<HTMLDivElement>();
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); }, [ref]);
  return (
    <div className="intro-confirm" ref={ref}>
      <p><b>{company} will see:</b> {shares}. Not your contact details.</p>
      <div className="intro-btns">
        <button type="button" className="btn primary" data-testid="intro-confirm" disabled={busy} onClick={onSend}>{busy ? 'Requesting' : 'Request intro'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

const STATUS: Record<IntroRequest['status'], { text: string; cls: string }> = {
  new: { text: 'New', cls: 'live' },
  awaiting_approval: { text: 'Awaiting approval', cls: 'warn' },
  accepted: { text: 'Accepted', cls: 'ok' },
  declined: { text: 'Declined', cls: 'bad' },
  delivered: { text: 'Delivered', cls: 'ok' },
};

function Inbox({ items }: { items: IntroRequest[] }) {
  if (!items.length) {
    return <p className="dash-empty surface">When a company with a matching opening asks to meet you, it shows here. They see only what you agreed to share.</p>;
  }
  return (
    <ol className="inbox">
      {items.map((r) => <InboxRow key={r.id} r={r} />)}
    </ol>
  );
}

function InboxRow({ r }: { r: IntroRequest }) {
  const ref = useEnterOnce<HTMLLIElement>();
  const s = STATUS[r.status];
  return (
    <li className="inbox-row surface" ref={ref}>
      <div className="inbox-top">
        <b className="inbox-co">{r.companyName}</b>
        <span className="inbox-role">{r.roleTitle}</span>
        <span className={`tag ${s.cls}`}>{s.text}</span>
        <span className="inbox-date" data-num>{r.direction === 'candidate_to_company' ? 'You asked' : 'They asked'}, {fmtDate(r.receivedAt)}, {fmtTime(r.receivedAt)}</span>
      </div>
      <div className="inbox-msg">{r.message.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}</div>
    </li>
  );
}
