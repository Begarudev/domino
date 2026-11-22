// "What's happening": the run as six connected steps, Read → Rules → Verify → Draft → Approve → Sent once.
// Every node is a real count from the company desk or the funnel, and opens the tab that holds its records.
// Timings come from the run journal (snap.steps) when the run has them; otherwise nothing is shown.
import { useMemo } from 'react';
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
interface Node { key: string; label: string; big: number | null; small: string; tab: CompanyTab; state: NodeState; steps: RegExp }

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

export function Pipeline({ desk, companyId, tab }: { desk: CompanyDesk; companyId: string; tab: CompanyTab }) {
  const funnel = useFunnel();
  const steps = useRunSel((v) => v.ui.snap?.steps);

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
    const st = (n: number | null, waiting = false): NodeState => (n == null || n === 0 ? (waiting ? 'waiting' : 'empty') : 'done');
    return [
      { key: 'read', label: 'Read', big: read, small: 'moves read', tab: 'reading', state: st(read), steps: STEPS.read },
      { key: 'rules', label: 'Rules', big: fired, small: `fired · ${fmtInt(held)} held`, tab: 'chains', state: st(fired + held), steps: STEPS.rules },
      { key: 'verify', label: 'Verify', big: verified, small: `met · ${fmtInt(cant)} can’t verify`, tab: 'verifier', state: st(verified + cant), steps: STEPS.verify },
      { key: 'draft', label: 'Draft', big: drafted, small: notDrafted ? `drafted · ${fmtInt(notDrafted)} not drafted` : 'drafted', tab: 'outreach', state: st(drafted), steps: STEPS.draft },
      awaiting || !approved
        ? { key: 'approve', label: 'Approve', big: awaiting, small: 'awaiting you', tab: 'outreach', state: awaiting ? 'waiting' : 'empty', steps: STEPS.approve }
        : { key: 'approve', label: 'Approve', big: approved, small: 'approved by you', tab: 'outreach', state: 'done', steps: STEPS.approve },
      { key: 'sent', label: 'Sent once', big: sent, small: 'delivered once', tab: 'ledger', state: st(sent), steps: STEPS.sent },
    ];
  }, [funnel.data, desk.openings, desk.intros]);

  const timing = (re: RegExp): string | null => {
    const mine = (steps ?? []).filter((s) => re.test(s.step) && s.startedAt && s.finishedAt);
    if (!mine.length) return null;
    const start = Math.min(...mine.map((s) => Date.parse(s.startedAt!)));
    const end = Math.max(...mine.map((s) => Date.parse(s.finishedAt!)));
    return end >= start ? secs(end - start) : null;
  };

  return (
    <nav className="pipe" aria-label="What’s happening in this run" data-testid="pipeline">
      <span className="pipe-h">What’s happening</span>
      <ol>
        {nodes.map((n, i) => {
          const to = { page: 'company', id: companyId, tab: n.tab } as const;
          const t = timing(n.steps);
          return (
            <li key={n.key} className={`pipe-n is-${n.state}`} style={{ animationDelay: `${i * 40}ms` }} aria-current={tab === n.tab ? 'step' : undefined}>
              <a href={href(to)} onClick={(e) => { e.preventDefault(); navigate(to, true); }} data-testid={`pipe-${n.key}`}
                title={`${n.label} (${n.key === 'read' ? 'whole scan' : 'this company'}): ${n.big == null ? 'not read yet' : `${fmtInt(n.big)} ${n.small}`}. Opens ${n.tab}.`}>
                <span className="pipe-dot" aria-hidden>{n.state === 'done' ? <svg viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-4.9" /></svg> : null}</span>
                <span className="pipe-txt">
                  <span className="pipe-l">{n.label}{t && <span className="pipe-t">{t}</span>}</span>
                  <span className="pipe-c"><b>{n.big == null ? '–' : fmtInt(n.big)}</b> {n.small}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
