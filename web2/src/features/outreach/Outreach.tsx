// Outreach (company side, Act): the footnoted intro draft, one approval, delivered once to the team inbox; a retry is
// skipped with the same receipt; kill and resume show the run recovering from its checkpoint. Every marker opens its
// dated source row. People appear as role and initial. Only user clicks POST (approve, kill, resume): never on load.
import { useEffect, useMemo, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import type { CompanyDesk } from '../../data/desk.ts';
import { deskApi, invalidate, useQuery } from '../../data/query.ts';
import { navigate, useRoute } from '../../data/router.ts';
import { runStore, useRunSel } from '../../data/store.ts';
import { fmtDate, fmtTime } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { sourceName } from '../../shell/EvidenceDrawer.tsx';
import { openEvidence } from '../../shell/ui.ts';
import type { IntroView, StepKey, StepState } from './model.ts';
import { STEP_CUR, STEP_LABEL, citationMap, dedupeIntros, draftLabel, isMonthly, markersIn, pieces, tidyClaim } from './model.ts';
import './outreach.css';

const initialOf = (label: string | null | undefined) => (label?.trim()?.[0] ?? '?').toUpperCase() + '.';
const ORDER: StepKey[] = ['draft', 'verified', 'approved', 'delivered'];

export function Outreach({ desk }: { desk: CompanyDesk }) {
  const route = useRoute();
  const routeId = route.page === 'company' ? route.id : desk.company.id;
  const intros = useMemo(() => dedupeIntros(desk.intros as IntroView[]), [desk.intros]);
  const [pick, setPick] = useState<string | null>(null);
  const intro = intros.find((r) => r.id === pick) ?? intros[0] ?? null;

  if (!intro) {
    return (
      <div className="empty-act" data-testid="outreach-empty">
        <p><b>No intro drafted yet.</b> Ask for one from a matched candidate in Recruitment.</p>
        <button className="btn" onClick={() => navigate({ page: 'company', id: routeId, tab: 'recruitment' })}>Open Recruitment</button>
      </div>
    );
  }
  return (
    <>
      {intros.length > 1 && (
        <div className="out-pick" role="tablist" aria-label="Intros, one per candidate">
          {intros.map((r) => (
            <button key={r.id} role="tab" aria-selected={r.id === intro.id} className="out-pick-b" onClick={() => setPick(r.id)}>
              Candidate {initialOf(candidateName(r))} · {r.roleTitle} <span className="faint">{fmtDate(r.receivedAt)}</span>
            </button>
          ))}
        </div>
      )}
      <IntroPanel key={intro.id} intro={intro} desk={desk} routeId={routeId} />
    </>
  );
}

/** "Asha K. opted in…" -> "Asha K."; only its initial is shown. */
function candidateName(r: IntroView): string | null {
  return r.message.match(/\n\n([A-Z][a-z]+ [A-Z]\.) opted in/)?.[1] ?? null;
}

type Outcome = { kind: 'delivered' } | { kind: 'duplicate' } | { kind: 'pending' } | { kind: 'error'; text: string };

function IntroPanel({ intro, desk, routeId }: { intro: IntroView; desk: CompanyDesk; routeId: string }) {
  // Scope the run store to this intro's run (approval, outbox, receipts, engine). Restore the page's run on leave.
  const attached = useRunSel((v) => v.runId);
  useEffect(() => {
    if (intro.runId && attached !== intro.runId) void runStore.attach(intro.runId);
  }, [intro.runId, attached]);
  useEffect(() => () => { if (desk.runId) void runStore.attach(desk.runId); else runStore.clear(); }, [desk.runId]);
  const mine = !!intro.runId && attached === intro.runId;

  const approvals = useRunSel((v) => v.ui.snap.approvals);
  const inbox = useRunSel((v) => v.ui.snap.receipts);
  const steps = useRunSel((v) => v.ui.snap.steps);
  const engine = useRunSel((v) => v.ui.snap.engine);
  const runStatus = useRunSel((v) => v.ui.snap.status);
  const timeline = useRunSel((v) => v.ui.timeline);
  const receipts = useRunSel((v) => v.ui.receipts);
  const notes = useRunSel((v) => v.ui.actionNotes);

  // The consented candidate fields the draft cites (title, skills, current role) are rows on the candidate's record.
  const cand = useQuery(intro.direction === 'candidate_to_company' ? `candidate:${intro.candidateId}` : null, () => deskApi.candidate(intro.candidateId));
  const evidence = useMemo(() => {
    const m = new Map<string, Evidence>();
    for (const e of desk.evidence ?? []) m.set(e.id, e);
    for (const e of (cand.data as { evidence?: Evidence[] } | null)?.evidence ?? []) m.set(e.id, e);
    return m;
  }, [desk.evidence, cand.data]);

  const cites = useMemo(() => citationMap(intro), [intro]);
  const markers = useMemo(() => markersIn(intro.message), [intro.message]);
  const paragraphs = useMemo(() => intro.message.split(/\n\n+/).filter(Boolean), [intro.message]);

  const approvalId = intro.approvalId ?? null;
  const approval = mine ? approvals.find((a) => a.id === approvalId) : undefined;
  const runReceipt = mine && approvalId ? receipts[approvalId] : undefined;
  const note = mine && approvalId ? notes[approvalId] : undefined;
  const key = intro.receipt?.idempotencyKey ?? runReceipt?.idempotencyKey ?? approval?.idempotencyKey ?? null;
  const inboxRow = mine && key ? inbox.find((r) => r.idempotencyKey === key) : undefined;
  const receivedAt = intro.receipt?.receivedAt ?? inboxRow?.receivedAt ?? (runReceipt?.status === 'delivered' ? runReceipt.receivedAt : null) ?? null;
  const delivered = intro.status === 'delivered' || !!intro.receipt || !!inboxRow || runReceipt?.status === 'delivered';

  const [busy, setBusy] = useState<null | 'approve' | 'retry' | 'kill' | 'resume'>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [engineMsg, setEngineMsg] = useState<string | null>(null);
  const duplicate = outcome?.kind === 'duplicate' || note?.kind === 'duplicate' || runReceipt?.status === 'already_delivered';

  const refresh = () => {
    invalidate(`company:${routeId}`);
    if (intro.runId) void runStore.attach(intro.runId);
  };
  // A drafting intro (no approval yet) settles when its run gates: refetch the desk once the run's approval lands.
  useEffect(() => { if (mine && approvals.length && !approvalId) invalidate(`company:${routeId}`); }, [mine, approvals.length, approvalId, routeId]);

  async function approve(retry: boolean) {
    if (!approvalId) return;
    setBusy(retry ? 'retry' : 'approve');
    try {
      const r = await runStore.decide(approvalId, 'approve') as { duplicate?: boolean; pending?: boolean; receipt?: { status: string } };
      setOutcome(r.duplicate || r.receipt?.status === 'already_delivered' ? { kind: 'duplicate' } : r.pending ? { kind: 'pending' } : { kind: 'delivered' });
    } catch (e) {
      setOutcome({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      refresh();
    }
  }
  async function kill() {
    setBusy('kill'); setEngineMsg(null);
    try {
      const r = await runStore.kill() as { killed?: boolean } | null;
      if (!r?.killed) setEngineMsg(`Nothing to kill: the engine isn’t running for this run (${statusWords(runStatus)}).`);
    } catch (e) { setEngineMsg(`Kill failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }
  async function resume() {
    setBusy('resume'); setEngineMsg(null);
    try { await runStore.resume(); refresh(); }
    catch (e) { const m = (e as Error).message; setEngineMsg(/cannot be resumed/i.test(m) ? `Nothing to resume: ${statusWords(runStatus)}, so there is no stopped step to continue.` : `Not resumed: ${m}.`); }
    finally { setBusy(null); }
  }

  // Engine state, from the run's own events.
  // The run snapshot keeps only outbound step rows, so crash and resume are read from the run's own event notes.
  const crashNote = [...timeline].reverse().find((t) => t.rule && /^Engine killed/.test(t.text));
  const crashStep = crashNote?.text.match(/ at (.+)$/)?.[1] ?? null;
  const resumeNote = [...timeline].reverse().find((t) => t.rule && /^Resumed:/.test(t.text));
  const reused = Number(resumeNote?.text.match(/(\d+) steps? reused/)?.[1] ?? steps.filter((s) => s.resumedFromCheckpoint).length);
  const dispatchKill = timeline.some((t) => /dispatcher SIGKILL/i.test(t.text));
  const crashed = mine && (engine.crashes > 0 || !!crashNote || dispatchKill);
  const resumed = mine && (engine.resumes > 0 || !!resumeNote);

  const blocked = intro.status === 'not_drafted';
  const drafting = !blocked && !approvalId;
  const approved = delivered || approval?.status === 'approved' || outcome?.kind === 'pending';
  const doneMap: Record<StepKey, boolean> = { draft: !!intro.message && !blocked, verified: !!approvalId, approved, delivered };
  const firstOpen = ORDER.find((s) => !doneMap[s]);
  const stepState = (k: StepKey): StepState => {
    if (doneMap[k]) return 'done';
    if (blocked) return k === 'draft' ? 'blocked' : 'todo';
    return firstOpen === k ? 'cur' : 'todo';
  };

  const verifiedCount = markers.filter((m) => (cites.get(m) ?? []).length).length;
  const excluded = intro.unverifiable ?? [];
  const deliveries = inboxRow?.deliveries ?? (delivered ? 1 : 0);
  const attempts = inboxRow?.attempts ?? null;
  const who = initialOf(candidateName(intro));

  return (
    <div className="out-grid">
      <section className="panel out-draft-panel" data-testid="outreach-draft">
        <header>
          <h2>To: {intro.direction === 'candidate_to_company' ? `Hiring team, ${intro.companyName}` : `Candidate ${who}`} <span className="faint out-to">team inbox</span></h2>
          {!blocked && intro.message && <span className="llm" data-testid="draft-label">{draftLabel(intro, verifiedCount)}</span>}
        </header>
        <div className="out-meta">
          <span>About <b>{intro.roleTitle}</b></span>
          <span>Requested by candidate <b>{who}</b>, who opted in</span>
          <span className="mono faint">{intro.id}</span>
        </div>
        {blocked ? (
          <div className="out-blocked" data-testid="not-drafted">
            <span className="st held">Not drafted</span>
            <p className="out-blocked-why">{intro.blockedReason ?? 'Not drafted: not enough verified evidence.'}</p>
            <p className="muted">An intro is drafted only when at least 2 verified, dated facts back it, one of them about the opening. Nothing was sent and there is nothing to approve.</p>
          </div>
        ) : drafting && !intro.message ? (
          <div className="out-blocked"><span className="st plain">Drafting</span><p className="muted">The intro run is checking each claim against its source. The draft appears here once every sentence cites a dated row.</p></div>
        ) : (
          <div className="out-body">
            <div className="draft">
              {paragraphs.map((p, i) => (
                <p key={i}><Para text={p} onMark={(m) => { const id = cites.get(m)?.[0]; if (id) openEvidence(id); }} /></p>
              ))}
            </div>
            <div className="hr" />
            <div className="fn-list">
              {markers.map((m) => {
                const ids = cites.get(m) ?? [];
                return (
                  <div className="fn" key={m} data-testid={`draft-fn-${m}`}>
                    <b>{m}</b>
                    <div className="fn-rows">
                      {ids.length ? ids.map((id) => <FnRow key={id} id={id} ev={evidence.get(id)} />) : <span className="faint">No source row attached</span>}
                    </div>
                  </div>
                );
              })}
              {excluded.map((x, i) => (
                <div className="fn" key={`x${i}`} data-testid="draft-excluded">
                  <span className="faint fn-x">×</span>
                  <div className="fn-rows"><div className="fn-row"><span className="struck fn-claim">{x.claim}</span><span className="fn-src">{x.reason}</span></div></div>
                  <span className="cant">I can’t verify</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="out-side">
        <section className="panel">
          <header><h2>Delivery</h2>{key && <span className="mono faint">key {key}</span>}</header>
          <div className="pad">
            <ol className="out-steps" data-testid="steps">
              {ORDER.map((k, i) => {
                const s = stepState(k);
                return (
                  <li key={k} className={s} aria-current={s === 'cur' ? 'step' : undefined}>
                    <span className="n">{s === 'done' ? '✓' : i + 1}</span>
                    <div><b>{s === 'cur' ? STEP_CUR[k] : STEP_LABEL[k]}</b><small>{stepNote(k, s, { intro, verifiedCount, approvalAt: approval?.decidedAt ?? undefined, receivedAt, draftedAt: mine ? steps.find((x) => x.step === "draft_intro")?.finishedAt ?? null : null })}</small></div>
                  </li>
                );
              })}
            </ol>
            {!blocked && (
              <div className="out-actions">
                <button className="btn pri" data-testid="approve" disabled={!approvalId || busy != null || approved}
                  onClick={() => approve(false)}>{busy === 'approve' ? 'Delivering…' : approved ? 'Approved' : 'Approve and send to team inbox'}</button>
                {delivered && (
                  <button className="btn" data-testid="approve-retry" disabled={busy != null} onClick={() => approve(true)}>
                    {busy === 'retry' ? 'Retrying…' : 'Retry delivery'}
                  </button>
                )}
              </div>
            )}
            {outcome?.kind === 'error' && <p className="bad-text out-msg" role="alert">Not delivered: {outcome.text}. Nothing was sent; try again.</p>}
            {outcome?.kind === 'pending' && !delivered && <p className="muted out-msg">Delivery was interrupted before the receipt was recorded. Retry delivery or resume the run: the test inbox won’t take it twice.</p>}
          </div>
        </section>

        <section className="panel">
          <header><h2>Deliveries</h2><span className="out-count" data-testid="deliveries">{deliveries}</span></header>
          <div className="pad">
            {delivered && key ? (
              <Receipt keyId={key} receivedAt={receivedAt} duplicate={duplicate} deliveries={deliveries} attempts={attempts} />
            ) : (
              <p className="faint out-none">{blocked ? 'Nothing to deliver: the intro was not drafted.' : 'Nothing delivered yet. Approving sends one intro to the team inbox.'}</p>
            )}
          </div>
        </section>

        {intro.runId && !blocked && (
          <section className="panel out-engine" data-testid="engine">
            <header><h2>Crash test</h2><span className="faint">{resumed ? 'resumed from checkpoint' : crashed ? 'stopped' : mine && engine.alive ? 'engine running' : 'engine idle'}</span></header>
            <div className="pad">
              {crashed && <EngineLine tone="stop" text={dispatchKill && !crashStep
                ? 'Delivery process stopped after the test inbox accepted (deliberate crash test)'
                : `Engine stopped during ${crashStep ? `“${crashStep[0].toUpperCase()}${crashStep.slice(1)}”` : 'a step'} (deliberate crash test)`} />}
              {resumed && <EngineLine tone="ok" text={`Resumed from checkpoint: ${reused} step${reused === 1 ? '' : 's'} reused, no paid call repeated`} />}
              {!crashed && !resumed && <p className="muted out-engine-p">Kill the engine, then resume the same run from its checkpoint. A retried delivery is skipped with the same receipt.</p>}
              {engineMsg && <p className="muted out-engine-p" role="status" data-testid="engine-msg">{engineMsg}</p>}
              <div className="out-actions">
                <button className="btn sm ghost" data-testid="kill" disabled={!mine || busy != null} onClick={kill}>{busy === 'kill' ? 'Killing…' : 'Kill engine'}</button>
                <button className="btn sm ghost" data-testid="resume" disabled={!mine || busy != null} onClick={resume}>{busy === 'resume' ? 'Resuming…' : 'Resume from checkpoint'}</button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** A paragraph with its footnote markers; each marker stays glued to the word before it (never wraps alone). */
function Para({ text, onMark }: { text: string; onMark: (m: number) => void }) {
  const ps = pieces(text);
  return <>{ps.map((x, j) => {
    if (!('text' in x)) return null;
    const next = ps[j + 1];
    if (!next || 'text' in next) return <span key={j}>{x.text}</span>;
    const cut = x.text.search(/\S+$/);
    const head = cut > 0 ? x.text.slice(0, cut) : '';
    const word = cut >= 0 ? x.text.slice(cut) : x.text;
    return (
      <span key={j}>{head}<span className="fn-glue">{word}<sup><button className="fn-mark" onClick={() => onMark(next.marker)}
        aria-label={`Open source ${next.marker}`}>{next.marker}</button></sup></span></span>
    );
  })}</>;
}

function FnRow({ id, ev }: { id: string; ev: Evidence | undefined }) {
  if (!ev) return <div className="fn-row"><button className="srclink" onClick={() => openEvidence(id)}>Source row {id.slice(0, 12)}</button></div>;
  const monthly = isMonthly(ev);
  const date = ev.observedAt ? fmtDate(monthly ? ev.observedAt.slice(0, 7) : ev.observedAt, true) : 'undated';
  return (
    <button className="fn-row fn-btn" onClick={() => openEvidence(id)}>
      <span className="fn-claim">{tidyClaim(ev.claim)}</span>
      <span className="fn-src">{date}{monthly && <span className="tag">month-level date</span>}<span aria-hidden>·</span>{sourceName(ev.source.endpoint, ev.source.provider)}</span>
    </button>
  );
}

function Receipt({ keyId, receivedAt, duplicate, deliveries, attempts }: {
  keyId: string; receivedAt: string | null; duplicate: boolean; deliveries: number; attempts: number | null;
}) {
  const ref = useEnterOnce<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="receipt">
      <div className="receipt">
        <span className="st verified">Delivered once</span>
        <span className="mono out-rc-key">{keyId}</span>{receivedAt && <span className="mono out-rc-time">{fmtDate(receivedAt)}, {fmtTime(receivedAt)}</span>}
      </div>
      <p className="out-rc-copy">One intro delivered to the team inbox.</p>
      {duplicate && <DupLine keyId={keyId} deliveries={deliveries} attempts={attempts} />}
    </div>
  );
}

function DupLine({ keyId, deliveries, attempts }: { keyId: string; deliveries: number; attempts: number | null }) {
  const ref = useEnterOnce<HTMLDivElement>();
  return (
    <div ref={ref} className="out-dup" data-testid="duplicate">
      <span className="st plain">Already delivered · skipped</span>
      <span className="muted">Same receipt <span className="mono">{keyId}</span>. Deliveries: {deliveries}{attempts != null && attempts > 1 ? `, attempts: ${attempts}` : ''}.</span>
    </div>
  );
}

function EngineLine({ tone, text }: { tone: 'stop' | 'ok'; text: string }) {
  const ref = useEnterOnce<HTMLDivElement>();
  return <div ref={ref} className={`out-eng ${tone}`}><i aria-hidden />{text}</div>;
}

function stepNote(k: StepKey, s: StepState, c: { intro: IntroView; verifiedCount: number; approvalAt?: string; receivedAt: string | null; draftedAt: string | null }): string {
  if (s === 'blocked') return 'Not enough verified evidence';
  switch (k) {
    case 'draft': { const at = c.draftedAt ?? (c.intro.status === 'delivered' ? null : c.intro.receivedAt); return s === 'done' ? (at ? `${fmtDate(at)}, ${fmtTime(at)}` : 'Drafted by the intro run') : 'Waiting for the intro run'; }
    case 'verified': return s === 'done' ? `Every claim cites a dated row (${c.verifiedCount} claims)` : 'Each sentence checked against its source';
    case 'approved': return s === 'done' ? (c.approvalAt ? `You approved, ${fmtTime(c.approvalAt)}` : 'You approved') : s === 'cur' ? 'Nothing is sent until you approve' : 'Your approval';
    case 'delivered': return s === 'done' ? (c.receivedAt ? `Test inbox, ${fmtTime(c.receivedAt)}` : 'Test inbox') : 'Team inbox, at most once';
  }
}

function statusWords(status: string): string {
  return ({ awaiting_approval: 'it is waiting for approval', done: 'the run has finished', crashed: 'it is stopped', running: 'running' } as Record<string, string>)[status] ?? status.replace(/_/g, ' ');
}
