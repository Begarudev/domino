// Run trace: what the backend did, step by step, for one run. A waterfall of the run journal grouped into six
// phases (Read → Rules → Verify → Draft → Approve → Deliver). Data: GET /api/runs/:id/summary only (read-only, 0 credits).
// A phase with nothing in this run says "Not reached in this run" and why; it is never blank.
import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { href, navigate } from '../../data/router.ts';
import type { Route } from '../../data/router.ts';
import './trace.css';

interface Step { step: string; label?: string; status: string; startedAt: string | null; finishedAt: string | null; ms: number | null }
interface Read { kind: string; endpoint: string; live: number; cache: number; blocked: number; failed: number; credits: number }
interface Summary {
  runId: string; pipeline: string; status: string; reads: Read[];
  rules: { mechanism: string; accounts: number; held: number }[];
  verify: { verifiedClaims: number; cantVerify: number };
  draft: { drafted: number; notDrafted: number; heldPreGate: number; generators: string[] };
  approve: { pending: number; approved: number; rejected: number };
  sent: { deliveries: number; outbox: number };
  steps: Step[]; credits: number; modelUsd: number;
}
type PhaseKey = 'read' | 'rules' | 'verify' | 'draft' | 'approve' | 'sent';
interface Row { tag?: string; id: string; state: 'ok' | 'held' | 'wait' | 'fail'; text: string; detail?: string[]; start?: number; end?: number }

const PHASES: { key: PhaseKey; label: string; who: string; re: RegExp }[] = [
  { key: 'read', label: 'Read', who: 'Crustdata, dated records', re: /^(parse_request|scope_search|pull_departures|resolve_departures|pull_triggers|resolve_entities|enrich_companies|fetch_profile|find_deciders)$/ },
  { key: 'rules', label: 'Rules', who: 'Fixed rules decide', re: /^(check_replacements|detect_openings|cascade|rank_targets|warm_paths)$/ },
  { key: 'verify', label: 'Verify', who: 'Each claim against a dated source', re: /^(verify|verify_claims|score_openings|score_replay)$/ },
  { key: 'draft', label: 'Draft', who: 'GPT-6 Luna writes, rules already decided', re: /^(draft_intro|draft|draft_messages)$/ },
  { key: 'approve', label: 'Approve', who: 'By you', re: /^(intro_gate|approval|approval_gate)$/ },
  { key: 'sent', label: 'Deliver', who: 'Sent once, checkpointed', re: /^(outbox|deliver|send)$/ },
];

const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`);
const n = (x: number) => x.toLocaleString('en-GB');
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const RULE_NAME: Record<string, string> = { DIRECT: 'DIRECT · the account itself moved', O1: 'O1 · departure opens a role', R1: 'R1 · replacement already hired', CONTAGION: 'CONTAGION · peers follow a move', DISPLACEMENT: 'DISPLACEMENT · a move frees a buyer' };

function stepState(s: string): Row['state'] {
  if (/fail|error|crash/.test(s)) return 'fail';
  if (/hold|held|block/.test(s)) return 'held';
  if (/done|ok|complete|skip|cached/.test(s)) return 'ok';
  return 'wait';
}

function build(sum: Summary) {
  const times = sum.steps.flatMap((s) => [s.startedAt, s.finishedAt]).filter(Boolean).map((t) => Date.parse(t!));
  const t0 = times.length ? Math.min(...times) : 0;
  const t1 = times.length ? Math.max(...times) : 0;
  const out: Record<PhaseKey, { rows: Row[]; why: string }> = {} as never;
  for (const p of PHASES) {
    const rows: Row[] = sum.steps.filter((s) => p.re.test(s.step)).map((s) => ({
      id: s.step, state: stepState(s.status),
      text: `${s.step === 'parse_request' ? 'GPT-6 Luna parsed the request' : s.label ?? s.step.replace(/_/g, ' ')}${s.status === 'skipped' ? ' · skipped in this run' : ''}${s.ms != null ? ` · ${secs(s.ms)}` : ''}`,
      detail: [s.step === 'parse_request' ? 'GPT-6 Luna parsed your request into a search; it decides nothing.' : `Step id ${s.step}`, `Status ${s.status}`, s.startedAt ? `Started ${new Date(s.startedAt).toLocaleTimeString('en-GB')}` : 'Not started'],
      start: s.startedAt ? Date.parse(s.startedAt) - t0 : undefined,
      end: s.finishedAt ? Date.parse(s.finishedAt) - t0 : undefined,
    }));
    let why = '';
    if (p.key === 'read') {
      for (const r of sum.reads) {
        const calls = r.live + r.cache + r.blocked + r.failed;
        rows.push({ tag: r.endpoint, id: `read-${r.endpoint}`, state: r.failed || r.blocked ? 'held' : 'ok',
          text: `${plural(calls, 'call')} to Crustdata ${r.kind} · ${n(r.live)} live, ${n(r.cache)} from cache · ${n(Math.round(r.credits * 10) / 10)} credits`,
          detail: [`Endpoint ${r.endpoint}`, `Live ${r.live} · Cache ${r.cache} · Budget-blocked ${r.blocked} · Failed or retried ${r.failed}`] });
      }
      why = 'This run made no Crustdata reads.';
    }
    if (p.key === 'rules') {
      for (const r of sum.rules) rows.push({ tag: 'rule, not timed', id: `rule-${r.mechanism}`, state: r.accounts ? 'ok' : 'held',
        text: `${RULE_NAME[r.mechanism] ?? r.mechanism}: fired for ${plural(r.accounts, 'account')}${r.held ? `, held for ${n(r.held)} (a guard failed)` : ''}` });
      why = 'No rule was evaluated: nothing was read for it to work on.';
    }
    if (p.key === 'verify') {
      const v = sum.verify;
      if (v.verifiedClaims + v.cantVerify) rows.push({ id: 'verify', state: v.cantVerify ? 'held' : 'ok',
        text: `${plural(v.verifiedClaims, 'claim')} verified against a dated source · ${n(v.cantVerify)} can’t verify, shown not hidden` });
      why = 'No draft carried claims to check yet.';
    }
    if (p.key === 'draft') {
      const d = sum.draft; const total = d.drafted + d.notDrafted + d.heldPreGate;
      if (total) rows.push({ id: 'draft', state: d.notDrafted || d.heldPreGate ? 'held' : 'ok',
        text: `GPT-6 Luna drafted ${n(d.drafted)} of ${n(total)}${d.notDrafted ? ` · ${n(d.notDrafted)} not drafted` : ''}${d.heldPreGate ? ` · ${n(d.heldPreGate)} held before the gate` : ''}`,
        detail: ['The model only writes. Which accounts get a draft was decided by the rules above.', ...d.generators] });
      why = 'No rule fired, so there was nothing to draft.';
    }
    if (p.key === 'approve') {
      const a = sum.approve;
      if (a.pending + a.approved + a.rejected) rows.push({ id: 'approve', state: a.pending ? 'wait' : 'ok',
        text: `${n(a.approved)} approved by you · ${n(a.rejected)} rejected · ${n(a.pending)} waiting for you` });
      why = 'No draft reached your approval queue.';
    }
    if (p.key === 'sent') {
      const s = sum.sent;
      if (s.deliveries + s.outbox) rows.push({ id: 'sent', state: 'ok',
        text: `${plural(s.deliveries, 'delivery', 'deliveries')} · ${n(s.outbox)} in the outbox, each sent once; a resume after a crash skips what was already delivered` });
      why = sum.approve.pending ? 'Waiting for your approval; nothing is sent without it.' : 'Nothing was approved, so nothing was sent.';
    }
    out[p.key] = { rows, why };
  }
  return { phases: out, total: t1 - t0 };
}

function useSummary(runId: string) {
  const [state, set] = useState<{ data?: Summary; err?: string }>({});
  useEffect(() => {
    let live = true;
    fetch(`/api/runs/${encodeURIComponent(runId)}/summary`).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'This run does not exist on this server.' : `The server answered ${r.status}.`);
      return r.json() as Promise<Summary>;
    }).then((d) => live && set({ data: d }), (e: Error) => live && set({ err: e.message }));
    return () => { live = false; };
  }, [runId]);
  return state;
}

export function TracePage({ route }: { route: Extract<Route, { page: 'trace' }> }) {
  const { data, err } = useSummary(route.runId);
  const reduce = useReducedMotion();
  const [closed, setClosed] = useState<Set<PhaseKey>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const built = useMemo(() => (data ? build(data) : null), [data]);
  const back = { page: 'company', id: route.id, tab: 'recruitment' } as const;
  const focus = PHASES.find((p) => p.key === route.phase)?.key;

  useEffect(() => { if (focus) document.getElementById(`trace-${focus}`)?.scrollIntoView({ block: 'start' }); }, [focus, built]);

  if (err) return <section className="trace"><p className="trace-empty">Couldn’t load the trace for run {route.runId.slice(0, 12)}. {err}</p></section>;
  if (!data || !built) return <section className="trace"><p className="trace-empty">Loading the run journal…</p></section>;

  const live = data.reads.reduce((s, r) => s + r.live, 0);
  const served = live ? `Live Crustdata reads · ${n(Math.round(data.credits * 10) / 10)} credits` : 'Replayed from cache · 0 new credits';
  const span = Math.max(built.total, 1);
  let i = 0;

  return (
    <section className="trace" data-testid="trace">
      <header className="trace-h">
        <a className="trace-back" href={href(back)} onClick={(e) => { e.preventDefault(); navigate(back); }}>Back to company</a>
        <h1>Run trace <span className="trace-id">{data.runId.slice(0, 12)}</span></h1>
        <p className="trace-sub">What DOMINO did for this run, in order. Rules decide; the model only drafts; nothing is sent without you.</p>
        <dl className="trace-meta">
          <div><dt>Served</dt><dd>{served}</dd></div>
          <div><dt>Total time</dt><dd>{built.total ? secs(built.total) : 'No timings recorded'}</dd></div>
          <div><dt>Credits</dt><dd>{n(Math.round(data.credits * 10) / 10)}</dd></div>
          <div><dt>Status</dt><dd>{data.status.replace(/_/g, ' ')}</dd></div>
        </dl>
      </header>
      <ol className="trace-phases">
        {PHASES.map((p, pi) => {
          const { rows, why } = built.phases[p.key];
          const isClosed = closed.has(p.key);
          return (
            <li key={p.key} id={`trace-${p.key}`} className={`tp${focus === p.key ? ' is-focus' : ''}`}>
              <button className="tp-h" aria-expanded={!isClosed} onClick={() => setClosed((s) => { const x = new Set(s); if (x.has(p.key)) x.delete(p.key); else x.add(p.key); return x; })}>
                <span className="tp-n">{pi + 1}</span>
                <span className="tp-l">{p.label}</span>
                <span className="tp-who">{p.who}</span>
                <span className="tp-c">{rows.length ? plural(rows.length, 'step') : 'Not reached'}</span>
                <svg className="tp-chev" viewBox="0 0 12 12" aria-hidden><path d="M3 4.5l3 3 3-3" /></svg>
              </button>
              {!isClosed && (rows.length ? (
                <ul className="tr-rows">
                  {rows.map((r) => {
                    const k = `${p.key}:${r.id}`; const d = i++;
                    const has = r.start != null;
                    const left = has ? (r.start! / span) * 100 : 0;
                    const width = has ? Math.max((((r.end ?? r.start!) - r.start!) / span) * 100, 0.6) : 0;
                    return (
                      <motion.li key={k} className={`tr is-${r.state}`}
                        initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: reduce ? 0 : Math.min(d * 0.03, 0.6) }}>
                        <button className="tr-b" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
                          <span className="tr-dot" aria-label={r.state} />
                          <span className="tr-t">{r.text}</span>
                          {has ? <span className="tr-bar" aria-hidden><i style={{ left: `${left}%`, width: `${width}%` }} /></span> : <span className="tr-tag">{r.tag ?? 'summary of this phase'}</span>}
                        </button>
                        {open === k && r.detail && <ul className="tr-d">{r.detail.map((x) => <li key={x}>{x}</li>)}</ul>}
                      </motion.li>
                    );
                  })}
                </ul>
              ) : <p className="tp-none">Not reached in this run. {why}</p>)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
