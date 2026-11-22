import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import type { Approval, DeliveryReceipt, Draft, RunSnapshot, Target } from '../../../shared/types.ts';
import { fmtDate } from '../dates.ts';
import type { UIState } from '../state.ts';
import { shortKey } from '../state.ts';

/** Renders "[1]" markers as superscript chips that highlight their evidence row on hover/focus. */
function Body(props: { text: string; draft: Draft; onHover: (id: string | null) => void; onPick: (id: string) => void }) {
  const parts = props.text.split(/(\[\d+\])/g);
  return (
    <p className="draft-body">
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        if (!m) return <Fragment key={i}>{p}</Fragment>;
        const marker = Number(m[1]);
        const cite = props.draft.citations.find((c) => c.marker === marker);
        if (!cite) return <sup key={i} className="cite-chip is-broken" title="No evidence for this marker">{marker}</sup>;
        return (
          <sup key={i}>
            <button
              type="button" className="cite-chip" aria-label={`Citation ${marker}, show evidence`}
              onMouseEnter={() => props.onHover(cite.evidenceId)} onMouseLeave={() => props.onHover(null)}
              onFocus={() => props.onHover(cite.evidenceId)} onBlur={() => props.onHover(null)}
              onClick={() => props.onPick(cite.evidenceId)}
            >{marker}</button>
          </sup>
        );
      })}
    </p>
  );
}

function ApprovalControls(props: { ap: Approval; note?: UIState['actionNotes'][string]; receipt?: DeliveryReceipt; onDecide: (id: string, d: 'approve' | 'reject') => void; busy: boolean; blocked?: string }) {
  const { ap, note } = props;
  const isMsg = ap.kind === 'send_message';
  const label = isMsg ? 'Approve and send to test inbox' : 'Approve meeting hold (test mode)';
  return (
    <div className={`approval approval-${ap.status}`}>
      <span className="approval-kind">{isMsg ? 'First message' : 'Meeting hold'}</span>
      {ap.status === 'pending' && (
        <div className="approval-btns">
          <button type="button" className="btn btn-primary btn-sm" disabled={props.busy || !!props.blocked} title={props.blocked} onClick={() => props.onDecide(ap.id, 'approve')}>{label}</button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={props.busy} onClick={() => props.onDecide(ap.id, 'reject')}>Reject</button>
        </div>
      )}
      {ap.status === 'pending' && props.blocked && <p className="approval-note is-dup">{props.blocked}</p>}
      {ap.status === 'rejected' && <p className="approval-note">Rejected. Nothing was sent.</p>}
      {ap.status === 'approved' && (
        <div className="approval-done">
          {note?.kind === 'duplicate' ? (
            <p className="approval-note is-dup">Already sent, key <code>{shortKey(note.key)}</code>, not sent again</p>
          ) : props.receipt?.status === 'already_delivered' ? (
            <p className="approval-note is-already">Already delivered, skipped, key <code>{shortKey(props.receipt.idempotencyKey)}</code></p>
          ) : (
            <p className="approval-note is-sent">{isMsg ? 'Sent once to test inbox' : 'Meeting hold booked once (test mode)'}, key <code>{shortKey(ap.idempotencyKey)}</code></p>
          )}
          <button type="button" className="btn btn-quiet btn-xs" disabled={props.busy} onClick={() => props.onDecide(ap.id, 'approve')} title="Approve again to show the outbox blocks a second send">{isMsg ? 'Send again' : 'Book again'}</button>
        </div>
      )}
    </div>
  );
}

function Decider({ t }: { t: Target }) {
  if (!t.decider) return <p className="drawer-warn">No decider found. I can't verify who decides here.</p>;
  const d = t.decider;
  return (
    <div className="decider">
      <p className="decider-name">{d.name}<span>{d.title}{d.tenureSince ? `, since ${fmtDate(d.tenureSince, { year: true })}` : ''}</span></p>
      <p className="decider-reason">{d.reason}</p>
      {t.testedClaim && <p className="tested">Replay tests for <b>{t.testedClaim}</b></p>}
      {t.path && (
        <p className={`path path-${t.path.strength}`}>
          <span className="path-strength">{{ warm: 'Warm path', lukewarm: 'Lukewarm path', cold: 'Cold' }[t.path.strength]}</span>
          {t.path.hops.map((h) => h.label).join(' → ')}
        </p>
      )}
    </div>
  );
}

export function DraftsTab(props: {
  state: UIState; selectedCompany: string | null; onSelectCompany: (id: string) => void; onHover: (id: string | null) => void;
  onPickEvidence: (id: string) => void; onDecide: (id: string, d: 'approve' | 'reject') => void; busy: string | null;
}) {
  const { snap, actionNotes } = props.state;
  const withDrafts = snap.targets.filter((t) => snap.drafts.some((d) => d.companyId === t.companyId));
  const current = withDrafts.find((t) => t.companyId === props.selectedCompany) ?? withDrafts[0];
  const [showRemoved, setShowRemoved] = useState(false);
  const name = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? id;

  if (!withDrafts.length) {
    return <p className="empty tab-empty">Drafts appear after DOMINO finds who decides at each target. Each one waits here for your approval; nothing is sent without it.</p>;
  }
  const draft = snap.drafts.find((d) => d.companyId === current.companyId)!;
  const approvals = snap.approvals.filter((a) => a.draftId === draft.id).sort((a) => (a.kind === 'send_message' ? -1 : 1));
  const removed = draft.checks.filter((c) => c.status === 'removed');
  const cited = draft.checks.filter((c) => c.status === 'cited').length;

  return (
    <div className="drafts">
      <ul className="draft-list" role="tablist" aria-label="Drafts by target">
        {withDrafts.map((t) => {
          const aps = snap.approvals.filter((a) => a.companyId === t.companyId);
          const pending = aps.filter((a) => a.status === 'pending').length;
          const on = t.companyId === current.companyId;
          return (
            <li key={t.companyId}>
              <button type="button" role="tab" aria-selected={on} className={`draft-tab${on ? ' is-on' : ''}`} onClick={() => props.onSelectCompany(t.companyId)}>
                <span className="draft-tab-name">{name(t.companyId)}</span>
                <span className="draft-tab-meta">{t.decider?.name ?? 'No decider'}</span>
                <span className={`draft-tab-state${pending ? '' : ' is-done'}`}>{pending ? `${pending} to approve` : aps.length ? 'Decided' : 'No approvals yet'}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <article className="draft" aria-label={`Draft to ${name(current.companyId)}`}>
        <div className="draft-main">
          <Decider t={current} />
          <p className="draft-subject"><span>Subject</span>{draft.subject}</p>
          <Body text={draft.body} draft={draft} onHover={props.onHover} onPick={props.onPickEvidence} />
          <p className="draft-gen">
            {draft.verified ? <span className="ok">Verified</span> : <span className="miss">Not verified</span>}: {cited} sentence{cited === 1 ? '' : 's'} cited, {removed.length} removed by the verifier. Written by {draft.generator === 'template' ? 'template, no model' : draft.generator.replace(/^llm:/, '')}.
          </p>
          {removed.length > 0 && (
            <div className="removed">
              <button type="button" className="disclosure" aria-expanded={showRemoved} onClick={() => setShowRemoved((s) => !s)}>
                Removed by verifier ({removed.length})
              </button>
              {showRemoved && (
                <ul>{removed.map((c, i) => <li key={i}><s>{c.sentence}</s>{c.note && <span>{c.note}</span>}</li>)}</ul>
              )}
            </div>
          )}
        </div>
        <aside className="draft-side">
          <Section title="I can't verify">
            {draft.unverifiable.length === 0 ? <p className="muted">Nothing left unverified.</p> : (
              <ul className="cant">{draft.unverifiable.map((u, i) => <li key={i}><b>{u.claim}</b><span>{u.reason}</span></li>)}</ul>
            )}
          </Section>
          <Section title="Meeting">
            <p className="muted">{draft.meeting.title}, {draft.meeting.durationMin} min</p>
            {draft.meeting.proposedSlots.length > 0 && (
              <p className="muted num">{draft.meeting.proposedSlots.map((s) => new Date(s).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join('; ')}</p>
            )}
          </Section>
          <div className="approvals">
            {approvals.length === 0 && <p className="muted">Approvals are created at the approval gate.</p>}
            {approvals.map((ap) => (
              <ApprovalControls key={ap.id} ap={ap} note={actionNotes[ap.id]} receipt={props.state.receipts[ap.id]} blocked={current.decider ? undefined : 'No decision-maker found, so this cannot be sent. Reject it or re-run.'} onDecide={props.onDecide} busy={props.busy === ap.id} />
            ))}
          </div>
        </aside>
      </article>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="side-sec"><h4>{title}</h4>{children}</section>;
}

export function pendingApprovals(snap: RunSnapshot) {
  return snap.approvals.filter((a) => a.status === 'pending').length;
}
