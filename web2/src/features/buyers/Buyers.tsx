// Find buyers (company side, Act): an outbound run's accounts. Each row is a rule decision about a target company
// (the cross-company rule, the dated trigger, the deciding role), and the selected row opens its footnoted draft.
// GET only on load: the run list and run snapshots. "Approve and send once" is the only POST, and only on a click.
import { useEffect, useMemo, useState } from 'react';
import type { Evidence, RunSnapshot } from '../../../../shared/types.ts';
import type { CompanyDesk } from '../../data/desk.ts';
import { deciderLabel } from '../../data/derive.ts';
import { runStore, useRunSel } from '../../data/store.ts';
import { fmtDate, fmtTime, plural } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { sourceName } from '../../shell/EvidenceDrawer.tsx';
import { openEvidence } from '../../shell/ui.ts';
import { isMonthly, markersIn, pieces, tidyClaim } from '../outreach/model.ts';
import '../outreach/outreach.css';
import type { Account, RunRow, StatusKind } from './model.ts';
import { accounts, draftLabel, isOutbound, readableDates, ruleWords } from './model.ts';
import './buyers.css';

type Loaded = { row: RunRow; snap: RunSnapshot };
type Filter = 'all' | 'ready' | 'sent' | 'blocked';
const BLOCKED: StatusKind[] = ['held', 'watch', 'not_drafted'];

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(`${url} answered ${r.status}`);
  return r.json() as Promise<T>;
}

export function Buyers({ desk }: { desk: CompanyDesk }) {
  const [runs, setRuns] = useState<Loaded[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(() => new URLSearchParams(location.search).get('buyers'));
  const [nonce, setNonce] = useState(0);

  // Load the newest outbound runs (GET). The default is the newest one that has drafts.
  useEffect(() => {
    let live = true;
    setErr(null);
    (async () => {
      const list = (await getJson<RunRow[]>('/api/runs')).filter(isOutbound).slice(0, 8);
      const snaps = await Promise.all(list.map((row) => getJson<RunSnapshot>(`/api/runs/${row.id}`).then((snap) => ({ row, snap })).catch(() => null)));
      if (live) setRuns(snaps.filter((x): x is Loaded => !!x));
    })().catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [nonce]);

  const chosen = useMemo(() => {
    if (!runs?.length) return null;
    return runs.find((r) => r.row.id === pick || (pick && r.row.id.startsWith(pick))) ?? [...runs].sort((a, b) => b.snap.drafts.length - a.snap.drafts.length)[0];
  }, [runs, pick]);

  // Attach the run so the evidence drawer and the approval use it; give the page its own run back on leave.
  const attached = useRunSel((v) => v.runId);
  const liveSnap = useRunSel((v) => v.ui.snap);
  useEffect(() => { if (chosen && attached !== chosen.row.id) void runStore.attach(chosen.row.id); }, [chosen, attached]);
  useEffect(() => () => { if (desk.runId) void runStore.attach(desk.runId); else runStore.clear(); }, [desk.runId]);

  if (err) {
    return (
      <div className="empty-act" role="alert">
        <p><b>Couldn’t load the outbound runs.</b> The server may be restarting; try again in a few seconds.</p>
        <p className="faint by-diag">{err}</p>
        <button className="btn" onClick={() => setNonce((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  if (!runs) return <BuyersSkeleton />;
  if (!chosen) {
    return (
      <>
        <RequestBox defaultText="" />
        <div className="empty-act" data-testid="buyers-empty"><p><b>No outbound run yet.</b> Describe what you sell above to prefill a run request.</p></div>
      </>
    );
  }
  const snap = attached === chosen.row.id && liveSnap.id === chosen.row.id ? liveSnap : chosen.snap;
  return <RunView key={chosen.row.id} snap={snap} runs={runs} onPick={setPick} />;
}

function RequestBox({ defaultText }: { defaultText: string }) {
  const [text, setText] = useState(defaultText);
  const [shown, setShown] = useState(false);
  return (
    <form className="by-ask" onSubmit={(e) => { e.preventDefault(); setShown(true); }}>
      <label htmlFor="by-ask-in">Describe what you sell</label>
      <input id="by-ask-in" value={text} onChange={(e) => { setText(e.target.value); setShown(false); }} placeholder="We sell managed GPU inference…" />
      <button className="btn" type="submit" disabled={!text.trim()}>Prefill run request</button>
      <span className="faint by-ask-note">{shown ? 'Prefilled. Runs cost credits, so this demo shows the latest run instead of starting one.' : 'Runs cost credits; this demo shows the latest run.'}</span>
    </form>
  );
}

function RunView({ snap, runs, onPick }: { snap: RunSnapshot; runs: Loaded[]; onPick: (id: string) => void }) {
  const rows = useMemo(() => accounts(snap), [snap]);
  const [filter, setFilter] = useState<Filter>('all');
  const ready = rows.filter((r) => r.status.kind === 'ready' || r.status.kind === 'approved').length;
  const sent = rows.filter((r) => r.status.kind === 'sent').length;
  const blocked = rows.filter((r) => BLOCKED.includes(r.status.kind)).length;
  const shown = rows.filter((r) => filter === 'all' || (filter === 'ready' ? r.status.kind === 'ready' || r.status.kind === 'approved'
    : filter === 'sent' ? r.status.kind === 'sent' : BLOCKED.includes(r.status.kind)));
  const [sel, setSel] = useState<string | null>(null);
  const current = shown.find((r) => r.target.companyId === sel) ?? shown[0] ?? null;
  const ev = useMemo(() => new Map(snap.evidence.map((e) => [e.id, e])), [snap.evidence]);
  const intent = snap.intent;
  const added = intent?.modelAdded;

  const count = (f: Filter, n: number, label: string) => (
    <button className={`by-count${filter === f ? ' on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(filter === f ? 'all' : f)}>
      <b>{n}</b> {label}
    </button>
  );

  return (
    <>
      <section className="panel by-head" data-testid="buyers-run">
        <div className="by-req">
          <q>{snap.request}</q>
          <div className="by-req-meta">
            <span className="mono">{fmtDate(snap.createdAt, true)}, {fmtTime(snap.createdAt)}</span>
            <span className="mono faint">{snap.id.slice(0, 12)}</span>
            <span>Window {intent?.windowDays ?? "?"} days to {fmtDate(intent?.asOf, true)}</span>
            <ModeTag evidence={snap.evidence} />
            {added && <span className="llm">{added.label || 'Terms added by GPT-6 Luna (schema-checked)'}</span>}
            {added && <span className="faint">{[...added.signalKeywords, ...added.deciderTitles].join(', ')}</span>}
          </div>
        </div>
        <div className="by-counts" role="group" aria-label="Filter accounts">
          {count('all', rows.length, rows.length === 1 ? 'account' : 'accounts')}
          {count('ready', ready, ready === 1 ? 'draft ready' : 'drafts ready')}
          {count('sent', sent, 'sent')}
          {blocked > 0 && count('blocked', blocked, 'held or not drafted')}
        </div>
      </section>

      {runs.length > 1 && (
        <label className="by-runs">
          <span className="faint">Showing run</span>
          <select value={snap.id} onChange={(e) => onPick(e.target.value)} data-testid="buyer-run-pick">
            {runs.map((r) => (
              <option key={r.row.id} value={r.row.id}>
                {fmtDate(r.row.createdAt)}, {fmtTime(r.row.createdAt)} · {short(r.row.request)} · {runCounts(r.snap)}
              </option>
            ))}
          </select>
          <span className="faint">{runs.length} outbound runs, newest first</span>
        </label>
      )}

      <div className="by-grid">
        <section className="panel by-accounts">
          <header><h2>Accounts, ranked</h2><span className="faint">people as role and initial</span></header>
          {shown.length ? (
            <table className="t by-t">
              <thead><tr><th>Company</th><th>Predicted need</th><th>Trigger</th><th>Decider</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((a) => (
                  <Row key={a.target.companyId} a={a} ev={ev} sel={current?.target.companyId === a.target.companyId}
                    onSel={() => setSel(a.target.companyId)} />
                ))}
              </tbody>
            </table>
          ) : <p className="faint by-none">No accounts in this filter.</p>}
        </section>
        {current && <DraftPanel key={current.target.companyId} a={current} ev={ev} snap={snap} />}
      </div>
      <RequestBox defaultText="" />
    </>
  );
}

function Row({ a, ev, sel, onSel }: { a: Account; ev: Map<string, Evidence>; sel: boolean; onSel: () => void }) {
  const t = a.target;
  const trigEv = a.trigger ? ev.get(a.trigger.evidenceIds[0]) : undefined;
  return (
    <tr className={sel ? 'sel' : undefined} aria-selected={sel} onClick={onSel} data-testid={`buyer-row-${t.companyId}`}>
      <td className="by-co"><b>{a.name}</b>{a.domain && <span className="mono faint">{a.domain}</span>}</td>
      <td className="by-need">
        <span className="by-rule">{t.mechanisms.map(ruleWords).join(' + ')}</span>
        <span>{readableDates(t.whyNow)}</span>
      </td>
      <td className="by-trig">
        {a.trigger ? (
          <>
            <span className="mono">{fmtDate(a.trigger.date, true)}{a.trigger.precision === 'month' && <span className="tag">month-level date</span>}</span>
            <span>{readableDates(trigEv ? tidyClaim(trigEv.claim) : a.trigger.summary).replace(/ on \d{1,2} [A-Z][a-z]{2} \d{4}(?=\.?$)/, '')}</span>
            {trigEv && <button className="srclink" onClick={(e) => { e.stopPropagation(); openEvidence(trigEv.id); }}>{sourceName(trigEv.source.endpoint, trigEv.source.provider)}</button>}{trigEv?.mode === 'fixture' && <span className="tag">fixture</span>}
          </>
        ) : t.whyNowDate ? <span className="mono">{fmtDate(t.whyNowDate, true)}</span> : <span className="cant">No dated trigger</span>}
      </td>
      <td className="by-dec">{t.decider ? deciderLabel(t.decider) : <span className="faint">No decider found</span>}</td>
      <td className="by-st">
        <span className={`st ${a.status.cls}`}>{a.status.label}</span>
        {a.status.why && <small>{a.status.why}</small>}
      </td>
    </tr>
  );
}

function DraftPanel({ a, ev, snap }: { a: Account; ev: Map<string, Evidence>; snap: RunSnapshot }) {
  const d = a.draft;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const receipt = a.send ? snap.receipts.find((r) => r.idempotencyKey === a.send!.idempotencyKey) : undefined;
  const outRow = a.send ? snap.outbox.find((o) => o.approvalId === a.send!.id) : undefined;
  const cites = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of d?.citations ?? []) if (!m.has(c.marker)) m.set(c.marker, c.evidenceId);
    return m;
  }, [d]);
  const markers = d ? markersIn(d.body) : [];
  const to = a.target.decider ? deciderLabel(a.target.decider) : (snap.intent?.deciderTitles ?? ["the deciding role"]).slice(0, 2).join(' or ');

  async function approve() {
    if (!a.send) return;
    setBusy(true); setMsg(null);
    try {
      const r = await runStore.decide(a.send.id, 'approve') as { ok?: boolean; error?: string };
      if (r && r.ok === false) setMsg(r.error ?? 'The server didn’t accept the approval. Nothing was sent.');
      void runStore.attach(snap.id);
    } catch (e) {
      setMsg(`Not sent: ${(e as Error).message}. Nothing was delivered; try again.`);
    } finally { setBusy(false); }
  }

  return (
    <section className="panel by-draft" data-testid="buyer-draft">
      <header>
        <h2>{a.name}</h2>
        {d && <span className="llm" data-testid="buyer-draft-label">{draftLabel(d, markers.filter((m) => cites.has(m)).length)}</span>}
      </header>
      <dl className="by-meta">
        <dt>Why ranked</dt>
        <dd><b>{a.target.mechanisms.map(ruleWords).join(' + ')}</b> · {readableDates(a.target.whyNow)}{a.target.whyNowDate && <span className="mono"> · {fmtDate(a.target.whyNowDate, true)}</span>}</dd>
        <dt>Target role</dt>
        <dd><b>{to}</b>{!a.target.decider && <span className="faint"> · no named decider verified</span>}</dd>
        <dt>Sends to</dt>
        <dd>Team test inbox, at most once</dd>
      </dl>
      {!d ? (
        <div className="out-blocked" data-testid="buyer-not-drafted">
          <span className={`st ${a.status.cls}`}>{a.status.label}</span>
          <p className="out-blocked-why">{a.status.why ?? 'No draft for this account.'}</p>
          <p className="muted">A draft is written only from verified, dated facts about this account. Nothing was sent and there is nothing to approve.</p>
        </div>
      ) : (
        <div className="out-body">
          <p className="by-sec">Facts used in this draft</p>
          <p className="by-subj"><span className="faint">Subject</span> {d.subject}</p>
          <div className="draft">
            {redactGreeting(d.body).split(/\n\n+/).filter(Boolean).map((p, i) => (
              <p key={i}>{pieces(readableDates(p)).map((x, j) => 'text' in x ? <span key={j}>{x.text}</span> : (
                <sup key={j}><button className="fn-mark" onClick={() => { const id = cites.get(x.marker); if (id) openEvidence(id); }} aria-label={`Open source ${x.marker}`}>{x.marker}</button></sup>
              ))}</p>
            ))}
          </div>
          <div className="hr" />
          <div className="fn-list">
            {markers.map((m) => {
              const id = cites.get(m); const e = id ? ev.get(id) : undefined;
              return (
                <div className="fn" key={m}>
                  <b>{m}</b>
                  <div className="fn-rows">
                    {e ? (
                      <button className="fn-row fn-btn" onClick={() => openEvidence(e.id)}>
                        <span className="fn-claim">{readableDates(tidyClaim(e.claim))}</span>
                        <span className="fn-src">{e.observedAt ? fmtDate(isMonthly(e) ? e.observedAt.slice(0, 7) : e.observedAt, true) : 'undated'}{isMonthly(e) && <span className="tag">month-level date</span>}<span aria-hidden>·</span>{sourceName(e.source.endpoint, e.source.provider)}{e.mode === 'fixture' && <span className="tag">fixture</span>}</span>
                      </button>
                    ) : <span className="faint">No source row attached</span>}
                  </div>
                </div>
              );
            })}
            {d.unverifiable.map((x, i) => (
              <div className="fn" key={`x${i}`}>
                <span className="faint fn-x">×</span>
                <div className="fn-rows"><div className="fn-row"><span className="struck fn-claim">{x.claim}</span><span className="fn-src">{x.reason}</span></div></div>
                <span className="cant">I can’t verify</span>
              </div>
            ))}
          </div>
          <div className="by-act">
            {a.status.kind === 'sent' ? (
              <Receipt keyId={outRow?.idempotencyKey ?? a.send!.idempotencyKey} at={receipt?.receivedAt ?? outRow?.executedAt ?? null} />
            ) : (
              <>
                <button className="btn pri" data-testid="buyer-approve" disabled={!a.send || busy || a.status.kind !== 'ready'} onClick={approve}>
                  {busy ? 'Sending…' : a.status.kind === 'approved' ? 'Approved' : 'Approve and send once'}
                </button>
                <span className="faint">{a.send ? `One message to the team test inbox, key ${a.send.idempotencyKey}` : 'No approval was created for this draft.'}</span>
              </>
            )}
          </div>
          {msg && <p className="bad-text out-msg" role="alert">{msg}</p>}
        </div>
      )}
    </section>
  );
}

function Receipt({ keyId, at }: { keyId: string; at: string | null }) {
  const ref = useEnterOnce<HTMLDivElement>();
  return (
    <div ref={ref} className="receipt" data-testid="buyer-receipt">
      <span className="st verified">Delivered once</span>
      <span>Delivered once to the team inbox</span>
      <span className="mono">{keyId}</span>
      {at && <span className="mono faint">{fmtDate(at)}, {fmtTime(at)}</span>}
    </div>
  );
}

function BuyersSkeleton() {
  return (
    <section className="panel by-accounts" aria-busy="true">
      <header><h2>Accounts</h2><span className="faint">loading the latest outbound run…</span></header>
      <div className="by-ghost">{[0, 1, 2].map((i) => <i key={i} />)}</div>
    </section>
  );
}

const short = (s: string) => (s.length > 44 ? `${s.slice(0, 42).trimEnd()}…` : s);

/** Drafts greet the decider by first name; the screen shows role and initial only ("Hi Dipak," -> "Hi D.,"). */
const redactGreeting = (body: string) => body.replace(/^(Hi|Hello|Dear) ([A-Z][\p{L}'-]+),/u, (_, hi, name) => `${hi} ${name[0]}.,`);

/** One truthful data label for the run: how many of its source rows are live, cached or labelled fixtures. */
function ModeTag({ evidence }: { evidence: Evidence[] }) {
  const n = { live: 0, cache: 0, fixture: 0 } as Record<string, number>;
  for (const e of evidence) n[e.mode ?? 'live'] = (n[e.mode ?? 'live'] ?? 0) + 1;
  const parts = [n.live && `${n.live} live`, n.cache && `${n.cache} cached`, n.fixture && `${n.fixture} fixture`].filter(Boolean);
  return <span className={`tag${n.fixture ? ' warn' : ' live'}`} data-testid="buyer-datamode">{parts.join(' · ')} source rows</span>;
}

/** "2 ready · 1 delivered · 2 not drafted" for the run picker, from the run's own rows. */
function runCounts(snap: RunSnapshot): string {
  const rows = accounts(snap);
  const n = (k: StatusKind[]) => rows.filter((r) => k.includes(r.status.kind)).length;
  const parts = [[n(['ready', 'approved']), 'ready'], [n(['sent']), 'delivered'], [n(['held', 'watch', 'not_drafted']), 'not drafted or held']] as const;
  const s = parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(' · ');
  return s || plural(rows.length, 'account');
}
