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
import { HowComputed } from './HowComputed.tsx';

type Loaded = { row: RunRow; snap: RunSnapshot };
type Filter = 'all' | 'ready' | 'sent' | 'blocked';
const BLOCKED: StatusKind[] = ['held', 'watch', 'not_drafted'];
/** Meaning palette (styles/colors.css): one tone per status, one hue per rule. */
const STATUS_TONE: Record<StatusKind, string> = {
  ready: 'tone-provisional', approved: 'tone-provisional', sent: 'tone-delivered', held: 'tone-held', watch: 'tone-watch', not_drafted: 'tone-not-evaluated',
};
const RULE_TONE: Record<string, string> = { CONTAGION: 'rule-contagion', DIRECT: 'rule-direct', DISPLACEMENT: 'rule-displacement' };

async function getJson<T>(url: string): Promise<T> {
  // Never hang on a stalled request: after 12s the page shows the error state with Try again, not endless skeletons.
  let r: Response;
  try { r = await fetch(url, { signal: AbortSignal.timeout(12000) }); }
  catch (e) { throw new Error(`${url} didn’t answer (${(e as Error).name === 'TimeoutError' ? 'timed out after 12s' : (e as Error).message})`); }
  if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(`${url} answered ${r.status}`);
  return r.json() as Promise<T>;
}

export function Buyers({ desk }: { desk: CompanyDesk }) {
  const [runs, setRuns] = useState<Loaded[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(() => new URLSearchParams(location.search).get('buyers'));
  const [nonce, setNonce] = useState(0);
  const [stage, setStage] = useState('Reading outbound runs…');

  // Load the newest outbound runs (GET). The default is the newest one that has drafts.
  useEffect(() => {
    let live = true;
    setErr(null);
    (async () => {
      setStage('Reading outbound runs…');
      const list = (await getJson<RunRow[]>('/api/runs')).filter(isOutbound).slice(0, 8);
      if (live) setStage(list.length + ' outbound runs found · loading each run’s accounts and drafts…');
      const snaps = await Promise.all(list.map((row) => getJson<RunSnapshot>(`/api/runs/${row.id}`).then((snap) => ({ row, snap })).catch(() => null)));
      if (live) setRuns(snaps.filter((x): x is Loaded => !!x));
    })().catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [nonce]);

  const chosen = useMemo(() => {
    if (!runs?.length) return null;
    // Default: the newest run whose drafts cite only live (or cached live) evidence. A run whose drafts cite fixture rows
    // is never the default, even if it says "live" (runs before 13:18 could mix them in); it stays pickable and labelled.
    const allLive = (r: Loaded) => {
      const mode = new Map(r.snap.evidence.map((e) => [e.id, e.mode]));
      // Skips the blocked-before-spend demo run (0 targets, 0 drafts) and integrity-check snapshots.
      if ((r.snap as { integrity?: unknown }).integrity || !r.snap.targets?.length) return false;
      return r.snap.drafts.length > 0 && r.snap.drafts.every((d) => d.citations.every((c) => mode.get(c.evidenceId) !== 'fixture'));
    };
    return runs.find((r) => r.row.id === pick || (pick && r.row.id.startsWith(pick)))
      ?? runs.find(allLive)
      ?? [...runs].sort((a, b) => b.snap.drafts.length - a.snap.drafts.length)[0];
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
  if (!runs) return <BuyersSkeleton stage={stage} />;
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
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => filter === 'all' || (filter === 'ready' ? r.status.kind === 'ready' || r.status.kind === 'approved'
    : filter === 'sent' ? r.status.kind === 'sent' : BLOCKED.includes(r.status.kind)))
    .filter((r) => !needle || [r.name, r.domain ?? '', r.target.mechanisms.map(ruleWords).join(' '), r.status.label].join(' ').toLowerCase().includes(needle));
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
          <header><h2>Accounts, ranked<HowComputed endpoint="GET /api/runs (newest 8 outbound), then GET /api/runs/:id"
            rule="Each target names the rule that fired and its dated trigger. A draft is written only when 2 verified, dated facts back it; otherwise the row is held with the reason."
            source={`Crustdata company enrich, person search, job search and news; GPT-6 Luna only refines terms and drafts. Run of ${fmtDate(snap.createdAt, true)}.`} /></h2>
            <span className="faint">{plural(shown.length, 'account')} · a draft needs 2 verified, dated facts · people as role and initial</span></header>
          {rows.length > 8 && (
            <div className="tb"><input className="tb-search" type="search" placeholder="Search company, rule, status" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" data-testid="buyers-search" /></div>
          )}
          {shown.length ? (
            <table className="t by-t">
              <colgroup><col className="c-co" /><col className="c-rule" /><col className="c-dec" /><col className="c-facts" /><col className="c-st" /></colgroup>
              <thead><tr><th>Company</th><th>Rule and trigger</th><th>Decider role</th><th className="num">Facts</th><th>Status</th></tr></thead>
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
      <td className="by-co">
        <span className="by-co-in">
          <span className="by-logo" aria-hidden>{a.name.replace(/^the\s+/i, '')[0]?.toUpperCase()}</span>
          <span className="by-co-t"><b title={a.name}>{a.name}</b>{a.domain && <span className="by-dom" title={a.domain}>{a.domain}</span>}</span>
        </span>
      </td>
      <td className="by-trig">
        <span className="by-rule-l">
          <span className={`ctag ${RULE_TONE[t.mechanisms[0]] ?? 'hue-grey'}`} title={readableDates(t.whyNow)}>{t.mechanisms.map(ruleWords).join(' + ')}</span>
          {a.trigger ? <span className="by-date">{fmtDate(a.trigger.date, true)}</span>
            : t.whyNowDate ? <span className="by-date">{fmtDate(t.whyNowDate, true)}</span> : <span className="cant">No dated trigger</span>}
          {a.trigger?.precision === 'month' && <span className="tag">month-level</span>}
        </span>
        {(() => {
          const what = a.trigger ? readableDates(trigEv ? tidyClaim(trigEv.claim) : a.trigger.summary).replace(/ on \d{1,2} [A-Z][a-z]{2} \d{4}(?=\.?$)/, '') : readableDates(t.whyNow);
          return (
            <span className="by-l2">
              {trigEv?.mode === 'fixture' && <span className="tag">fixture</span>}
              {trigEv ? (
                <button className="by-ell by-evbtn" title={`${what} · source: ${sourceName(trigEv.source.endpoint, trigEv.source.provider)}`}
                  onClick={(e) => { e.stopPropagation(); openEvidence(trigEv.id); }}>{what}</button>
              ) : <span className="by-ell" title={what}>{what}</span>}
            </span>
          );
        })()}
      </td>
      <td className="by-dec"><span className="by-ell" title={t.decider ? deciderLabel(t.decider) : undefined}>{t.decider ? deciderLabel(t.decider) : <span className="faint">No decider found</span>}</span></td>
      <td className={`by-facts num${a.facts.have >= a.facts.need ? ' ok' : ''}`} title={`${a.facts.have} of ${a.facts.need} verified, dated facts needed to draft`}>
        <b>{a.facts.have}</b><span> of {a.facts.need}</span>
      </td>
      <td className="by-st">
        <span className={`ctag by-stp ${STATUS_TONE[a.status.kind]}`} title={a.status.label}><span>{a.status.label}</span></span>
        {a.status.why && <small className="by-ell by-why" title={a.status.why}>{a.status.why}</small>}
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

function BuyersSkeleton({ stage }: { stage: string }) {
  return (
    <section className="panel by-accounts" aria-busy="true">
      <header><h2>Accounts</h2><span className="faint" role="status" aria-live="polite">{stage}</span></header>
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
