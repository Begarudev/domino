// Read-only views for first-time viewers: what today's scan covered, and what one run did step by step. Built only
// from stored scan and run data (0 credits, no provider calls). People stay role + initial (the /api redactor applies).
import type { RoleFamily } from '../../shared/desk.ts';
import { ROLE_FAMILY_LABELS } from '../../shared/desk.ts';
import type { Store } from '../db.ts';
import { snapshot } from '../snapshot.ts';
import { openingsSnapshot } from './store.ts';
import type { OpeningsSnapshot } from './store.ts';
import { servedFrom } from './rules.ts';

// The openings scan reads departures from these families' titles (DEPARTURE_PHRASES); backend / payments is not read.
export const SCANNED_FAMILIES: RoleFamily[] = ['inference', 'ml_platform', 'mlops', 'gpu_llm_infra'];

export interface ScanCoverage {
  runId: string;
  scanAt: string;
  scannedFamilies: { id: RoleFamily; label: string }[];
  notScanned: { id: RoleFamily; label: string }[];
  counts: { jobMovesRead: number; companiesChecked: number; open: number; watch: number; held: number };
  rule: 'O1';
  served: ReturnType<typeof servedFrom>;
}

export function scanCoverage(store: Store, scan: OpeningsSnapshot | null = openingsSnapshot(store)): ScanCoverage | null {
  if (!scan) return null;
  const run = store.requireRun(scan.runId);
  const funnel = store.getOutput<{ funnel?: { stages: { id: string; count: number }[] } }>(scan.runId, 'detect_openings')?.funnel;
  const family = (id: RoleFamily) => ({ id, label: ROLE_FAMILY_LABELS[id] });
  const all = Object.keys(ROLE_FAMILY_LABELS) as RoleFamily[];
  const status = (value: string) => scan.openings.filter(row => row.status === value).length;
  return {
    runId: scan.runId, scanAt: run.created_at,
    scannedFamilies: SCANNED_FAMILIES.map(family), notScanned: all.filter(id => !SCANNED_FAMILIES.includes(id)).map(family),
    counts: {
      jobMovesRead: funnel?.stages.find(stage => stage.id === 'profiles')?.count ?? scan.departures.length,
      companiesChecked: scan.companies.length, open: status('open'), watch: status('watch'), held: status('held'),
    },
    rule: 'O1', served: servedFrom(store, scan.runId),
  };
}

export interface RunSummary {
  runId: string;
  pipeline: string;
  status: string;
  reads: { kind: 'person' | 'company' | 'job' | 'news' | 'other'; endpoint: string; live: number; cache: number; blocked: number; failed: number; credits: number }[];
  rules: { mechanism: string; accounts: number; held: number }[];
  verify: { verifiedClaims: number; cantVerify: number };
  draft: { drafted: number; notDrafted: number; heldPreGate: number; generators: string[] };
  approve: { pending: number; approved: number; rejected: number };
  sent: { deliveries: number; outbox: number };
  steps: { step: string; label: string; status: string; startedAt: string | null; finishedAt: string | null; ms: number | null }[];
  credits: number;
  modelUsd: number;
}

const kindOf = (endpoint: string): RunSummary['reads'][number]['kind'] =>
  /person|departure|decider|moves|profile/i.test(endpoint) ? 'person'
    : /company|growth|enrich|firmographic/i.test(endpoint) ? 'company'
      : /job/i.test(endpoint) ? 'job' : /news|web|fetch/i.test(endpoint) ? 'news' : 'other';

export function runSummary(store: Store, runId: string): RunSummary | null {
  if (!store.getRun(runId)) return null;
  const run = snapshot(store, runId);
  const reads = new Map<string, RunSummary['reads'][number]>();
  for (const row of run.ledger.filter(entry => entry.provider === 'crustdata')) {
    const read = reads.get(row.endpoint) ?? { kind: kindOf(row.endpoint), endpoint: row.endpoint, live: 0, cache: 0, blocked: 0, failed: 0, credits: 0 };
    if (row.status === 'budget_blocked') read.blocked++;
    else if (row.mode === 'live' && row.status === 'ok') read.live++;
    else if (row.status === 'cache_hit' || (row.mode === 'cache' && row.status === 'ok')) read.cache++;
    else if (row.mode !== 'cache') read.failed++;   // timeouts, errors and rejected (nonsense) replies, retried or skipped
    read.credits += row.credits;
    reads.set(row.endpoint, read);
  }
  const mechanisms = [...new Set(run.targets.flatMap(target => target.mechanisms))];
  const byId = new Map(run.evidence.map(row => [row.id, row]));
  const verifiedClaims = run.drafts.reduce((sum, draft) => sum + new Set(draft.citations.filter(cite => {
    const row = byId.get(cite.evidenceId);
    return row?.verifiable && row.observedAt && draft.body.includes(`[${cite.marker}]`);
  }).map(cite => cite.evidenceId)).size, 0);
  const count = (status: string) => run.approvals.filter(approval => approval.status === status).length;
  return {
    runId, pipeline: store.requireRun(runId).pipeline ?? 'outbound', status: run.status,
    reads: [...reads.values()],
    rules: mechanisms.map(mechanism => {
      const targets = run.targets.filter(target => target.mechanisms.includes(mechanism));
      return { mechanism, accounts: targets.filter(target => !target.hold).length, held: targets.filter(target => target.hold).length };
    }),
    verify: { verifiedClaims, cantVerify: run.drafts.reduce((sum, draft) => sum + draft.unverifiable.length, 0) },
    draft: {
      drafted: run.drafts.filter(draft => (draft.status ?? 'ready') === 'ready').length,
      notDrafted: run.drafts.filter(draft => draft.status === 'not_drafted').length,
      heldPreGate: run.drafts.filter(draft => draft.status === 'held_pre_gate').length,
      generators: [...new Set(run.drafts.map(draft => draft.generatorLabel).filter((label): label is string => Boolean(label)))],
    },
    approve: { pending: count('pending'), approved: count('approved'), rejected: count('rejected') },
    sent: { deliveries: run.receipts.reduce((sum, receipt) => sum + (receipt.deliveries ?? 0), 0), outbox: run.outbox.length },
    steps: run.steps.map(step => ({
      step: step.step, label: step.label, status: step.status, startedAt: step.startedAt ?? null, finishedAt: step.finishedAt ?? null,
      ms: step.startedAt && step.finishedAt ? Date.parse(step.finishedAt) - Date.parse(step.startedAt) : null,
    })),
    credits: run.budget.used.credits, modelUsd: run.budget.used.modelUsd,
  };
}
