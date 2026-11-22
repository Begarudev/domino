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

// Mini chart: the scan funnel, each stage a bar scaled against stage 1. Hover names the stage and its count.
function FunnelBars({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  const w = 10; const gap = 3; const h = 24;
  return (
    <svg className="pipe-bars" width={stages.length * (w + gap)} height={h} viewBox={`0 0 ${stages.length * (w + gap)} ${h}`} role="img"
      aria-label={`Scan funnel: ${stages.map((s) => `${s.label} ${s.count}`).join(', ')}`}>
      {stages.map((s, i) => {
        const bh = s.count ? Math.max(2, (s.count / max) * h) : 1;
        return <rect key={s.id} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1.5} className={s.count ? 'on' : 'off'}><title>{`${s.label}: ${fmtInt(s.count)}`}</title></rect>;
      })}
    </svg>
  );
}

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
      : `this company’s moves among the ${fmtInt(read)} read don’t meet Rule O1 (2+ conclusive departures in one role family, 90 days, no replacement)`;
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

  const stages = funnel.data?.stages ?? [];
  const reached = nodes.filter((n) => n.state !== 'empty').length;

  return (
    <nav className="pipe" aria-label="What’s happening in this run" data-testid="pipeline">
      <div className="pipe-head">
        <span className="pipe-h">What’s happening</span>
        <span className="pipe-sum">{reached} of {nodes.length} steps reached</span>
        <button type="button" className="pipe-how" aria-expanded={how} onClick={() => setHow((v) => !v)}>How this is computed</button>
      </div>
      {how && (
        <p className="pipe-howtxt">
          Read counts the whole scan: stage 1 of <code>GET /api/openings/funnel</code> (Crustdata person search, dated). Rules, Verify, Draft,
          Approve and Sent count this company’s desk: openings fired or held by the O1 rule and its guards, clauses the verifier marked met or
          can’t verify, and intros by status. Timings come from the run journal. Click a step to open its tab; “trace” opens that phase
          of <code>GET /api/runs/:id/summary</code>.
        </p>
      )}
      <ol>
        {nodes.map((n, i) => {
          const to = { page: 'company', id: companyId, tab: n.tab } as const;
          const tr = runId ? ({ page: 'trace', id: companyId, runId, phase: n.key } as const) : null;
          const t = timing(n.steps);
          return (
            <li key={n.key} className={`pipe-n pipe-${n.key} is-${n.state}`} style={{ animationDelay: `${i * 50}ms` }} aria-current={tab === n.tab ? 'step' : undefined}>
              <a className="pipe-main" href={href(to)} onClick={(e) => { e.preventDefault(); if (tab !== n.tab) navigate(to); }} data-testid={`pipe-${n.key}`}
                title={`${n.label} (${n.scope}). Opens ${n.tabName}.`}>
                <span className="pipe-top">
                  <span className="pipe-dot" aria-hidden>{n.state === 'done' ? <svg viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-4.9" /></svg> : null}</span>
                  <span className="pipe-l">{n.label}</span>
                  <span className={`pipe-chip is-${n.state}`}>{STATE_WORD[n.state]}</span>
                  {t && <span className="pipe-t">{t}</span>}
                </span>
                <span className="pipe-does">{n.does}</span>
                <span className="pipe-c">
                  <b>{n.big == null ? '–' : fmtInt(n.big)}</b> {n.small}
                  {n.key === 'read' && stages.length > 1 && <FunnelBars stages={stages} />}
                </span>
                {n.state !== 'done' && n.why && <span className="pipe-why">{n.state === 'waiting' ? 'Next: ' : 'Because '}{n.why}.</span>}
              </a>
              {tr && (
                <a className="pipe-tr" href={href(tr)} onClick={(e) => { e.preventDefault(); navigate(tr); }} data-testid={`pipe-trace-${n.key}`}
                  title={`Open the run trace at ${n.label}`}>trace</a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
