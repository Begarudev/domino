// "What's happening": the run as six connected steps, Read → Rules → Verify → Draft → Approve → Sent once.
// Each step says what it does in plain words, its real count, and its state: done, waiting on you, or not reached
// (with the reason, which is always the step before it coming up empty). Counts: Read is the whole scan
// (GET /api/openings/funnel, stage 1); every other step is this company's desk. Clicking a step opens the tab that
// holds its records; the small "trace" link opens the same phase in the run trace (GET /api/runs/:id/summary).
// Timings come from the run journal (snap.steps) when the run has them; otherwise nothing is shown.
import { useMemo, useState } from 'react';
import type { CompanyDesk } from '../../data/desk.ts';
import { openingLabel } from '../../data/desk.ts';
import { useQuery } from '../../data/query.ts';
import { href, navigate } from '../../data/router.ts';
import type { CompanyTab } from '../../data/router.ts';
import { useRunSel } from '../../data/store.ts';
import { fmtInt } from '../../lib/format.ts';
import type { FunnelStage } from '../../../../shared/desk.ts';
import './pipeline.css';

interface FunnelLite { runId?: string; stages?: FunnelStage[] }
type NodeState = 'done' | 'waiting' | 'empty';
interface Node {
  key: string; label: string; does: string; big: number | null; small: string; tab: CompanyTab; tabName: string;
  state: NodeState; why?: string; steps: RegExp; scope: string;
}

// Which run-journal steps belong to which node (openings + intro pipelines).
const STEPS: Record<string, RegExp> = {
  read: /^(scope_search|pull_departures|resolve_departures|pull_triggers|resolve_entities|enrich_companies|fetch_profile)$/,
  rules: /^(check_replacements|detect_openings|cascade|rank_targets)$/,
  verify: /^(verify|verify_claims|score_openings)$/,
  draft: /^(draft_intro|draft)$/,
  approve: /^(intro_gate|approval)$/,
  sent: /^(outbox|deliver|send)$/,
};

function useFunnel() {
  return useQuery<FunnelLite | null>('funnel', async () => {
    const r = await fetch('/api/openings/funnel').catch(() => null);
    const ok = r && r.ok && (r.headers.get('content-type') ?? '').includes('json');
    return { data: ok ? (await r.json()) as FunnelLite : null, source: 'live', evidence: [] };
  });
}

const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`);
const STATE_WORD: Record<NodeState, string> = { done: 'Done', waiting: 'Waiting on you', empty: 'Not reached' };

export function Pipeline({ desk, companyId, tab }: { desk: CompanyDesk; companyId: string; tab: CompanyTab }) {
  const funnel = useFunnel();
  const steps = useRunSel((v) => v.ui.snap?.steps);
  const runId = useRunSel((v) => v.runId);
  const [how, setHow] = useState(false);

  const nodes = useMemo<Node[]>(() => {
    const read = funnel.data?.stages?.[0]?.count ?? null;
    const fired = desk.openings.filter((o) => openingLabel(o) !== 'held').length;
    const held = desk.openings.filter((o) => openingLabel(o) === 'held').length;
    const clauses = desk.openings.flatMap((o) => o.clauses ?? []);
    const verified = clauses.filter((c) => c.state === 'met').length;
    const cant = clauses.filter((c) => c.state === 'cant_verify').length;
    const intros = desk.intros ?? [];
    const drafted = intros.filter((i) => i.status !== 'not_drafted').length;
    const notDrafted = intros.length - drafted;
    const awaiting = intros.filter((i) => i.status === 'awaiting_approval' || i.status === 'new').length;
    const sent = intros.filter((i) => i.status === 'delivered').length;
    const approved = intros.filter((i) => i.status === 'delivered' || i.status === 'accepted').length;
    const st = (n: number | null): NodeState => (n == null || n === 0 ? 'empty' : 'done');

    const rulesWhy = read == null
      ? 'nothing has been read in this scan yet'
      : `none of its moves among the ${fmtInt(read)} read met O1 (needs 2+ departures in one role family, 20–5,000 staff)`;
    const list: Node[] = [
      { key: 'read', label: 'Read', does: 'Pull dated job moves from Crustdata', big: read, small: 'moves read', tab: 'reading', tabName: 'Reading log',
        state: st(read), why: read == null ? 'the scan has not read anything yet' : undefined, steps: STEPS.read, scope: 'whole scan' },
      { key: 'rules', label: 'Rules', does: 'Fixed rules turn a move into an opening', big: fired, small: `fired · ${fmtInt(held)} held`, tab: 'chains', tabName: 'Chains',
        state: st(fired + held), why: rulesWhy, steps: STEPS.rules, scope: 'this company' },
      { key: 'verify', label: 'Verify', does: 'Check each claim against a dated source', big: verified, small: `met · ${fmtInt(cant)} can’t verify`, tab: 'verifier', tabName: 'Verifier',
        state: st(verified + cant), why: 'no rule fired, so there are no claims to check', steps: STEPS.verify, scope: 'this company' },
      { key: 'draft', label: 'Draft', does: 'GPT-6 Luna writes the intro; it decides nothing', big: drafted, small: notDrafted ? `drafted · ${fmtInt(notDrafted)} not drafted` : 'drafted', tab: 'outreach', tabName: 'Outreach',
        state: st(drafted), why: 'nothing was verified to draft from', steps: STEPS.draft, scope: 'this company' },
      awaiting || !approved
        ? { key: 'approve', label: 'Approve', does: 'You approve or reject every draft', big: awaiting, small: 'awaiting you', tab: 'outreach', tabName: 'Outreach',
          state: awaiting ? 'waiting' : 'empty', why: 'no draft is in your queue', steps: STEPS.approve, scope: 'this company' }
        : { key: 'approve', label: 'Approve', does: 'You approve or reject every draft', big: approved, small: 'approved by you', tab: 'outreach', tabName: 'Outreach',
          state: 'done', steps: STEPS.approve, scope: 'this company' },
      { key: 'sent', label: 'Sent once', does: 'Delivered once; a resume skips what was sent', big: sent, small: 'delivered once', tab: 'ledger', tabName: 'Ledger',
        state: st(sent), why: awaiting ? 'waiting for your approval; nothing sends without it' : 'nothing was approved, so nothing was sent', steps: STEPS.sent, scope: 'this company' },
    ];
    // A step after an unreached step names that step as the reason, so the chain reads left to right.
    for (let i = 2; i < list.length; i++) {
      if (list[i].state === 'empty' && list[i - 1].state === 'empty') list[i].why = `${list[i - 1].label} was not reached`;
    }
    return list;
  }, [funnel.data, desk.openings, desk.intros]);

  const timing = (re: RegExp): string | null => {
    const mine = (steps ?? []).filter((s) => re.test(s.step) && s.startedAt && s.finishedAt);
    if (!mine.length) return null;
    const start = Math.min(...mine.map((s) => Date.parse(s.startedAt!)));
    const end = Math.max(...mine.map((s) => Date.parse(s.finishedAt!)));
    return end >= start ? secs(end - start) : null;
  };


  // Where the run stopped: the first step that is waiting on you or was not reached. Its reason is the sentence.
  const stop = nodes.find((n) => n.state !== 'done');
  const sent = nodes[nodes.length - 1];
  const sentence = !stop
    ? `Delivered once · ${fmtInt(sent.big ?? 0)} ${sent.big === 1 ? 'intro' : 'intros'} approved by you`
    : stop.state === 'waiting'
      ? `Waiting on you at ${stop.label}: ${fmtInt(stop.big ?? 0)} ${stop.small}; nothing sends without your approval`
      : `Stopped at ${stop.label}: ${stop.why ?? 'not reached in this scan'}`;

  return (
    <nav className="pipe" aria-label="What’s happening in this run" data-testid="pipeline">
      <ol>
        {nodes.map((n, i) => {
          const to = { page: 'company', id: companyId, tab: n.tab } as const;
          const t = timing(n.steps);
          const tone = n.state === 'empty' ? 'off' : n.state === 'waiting' ? 'wait' : n.key === 'sent' ? 'sent' : 'done';
          return (
            <li key={n.key} className={`pipe-n is-${tone}${stop === n ? ' is-stop' : ''}`} style={{ animationDelay: `${i * 40}ms` }} aria-current={tab === n.tab ? 'step' : undefined}>
              <a href={href(to)} onClick={(e) => { e.preventDefault(); if (tab !== n.tab) navigate(to); }} data-testid={`pipe-${n.key}`}
                data-tip={`${n.does}. ${n.big == null ? 'Not read yet' : `${fmtInt(n.big)} ${n.small}`} (${n.scope}) · ${STATE_WORD[n.state]}${t ? ` · ${t}` : ''}. Opens ${n.tabName}.`}
                aria-label={`${n.label}: ${n.big == null ? 'not read' : `${fmtInt(n.big)} ${n.small}`}, ${STATE_WORD[n.state]}. Opens ${n.tabName}.`}>
                <span className="pipe-dot" aria-hidden />
                <span className="pipe-l">{n.label}</span>
                <span className="pipe-c">{n.big == null ? '–' : fmtInt(n.big)}</span>
              </a>
            </li>
          );
        })}
      </ol>
      <p className="pipe-why" title={sentence}>{sentence}</p>
      <span className="pipe-info">
        <button type="button" className="pipe-i" aria-expanded={how} aria-label="How this is computed" onClick={() => setHow((v) => !v)}>i</button>
        {how && (
          <span className="pipe-pop" role="dialog" aria-label="How this is computed">
            <b>How this is computed</b>
            <span>Read: the whole scan, stage 1 of <code>GET /api/openings/funnel</code> (Crustdata person search, dated records).</span>
            <span>Rules: this company’s openings fired or held by Rule O1 and its guards. Verify: clauses the verifier marked met or can’t verify.</span>
            <span>Draft (GPT-6 Luna writes, decides nothing), Approve (by you) and Sent once: this company’s intros by status.</span>
            <span>The run trace for each phase is <code>GET /api/runs/:id/summary</code>{runId ? <> · <a href={href({ page: 'trace', id: companyId, runId })} onClick={(e) => { e.preventDefault(); navigate({ page: 'trace', id: companyId, runId }); }}>open it</a></> : null}.</span>
          </span>
        )}
      </span>
    </nav>
  );
}
