// Pure helpers for Chains (the rules registry) and the Verifier. Everything here reads live data shapes from
// shared/desk.ts; nothing invents a number. A count is shown only when an endpoint returned it.
import type { Evidence } from '../../../../shared/types.ts';
import type { RuleCard, RuleClause, DossierRule } from '../../../../shared/desk.ts';
import type { CompanyDesk, CompanyDossier, CompanySummary, Opening, Sourced } from '../../data/desk.ts';
import { ROLE_FAMILY_LABELS, openingLabel } from '../../data/desk.ts';
import { deskApi, useQuery } from '../../data/query.ts';
import { fmtDate } from '../../lib/format.ts';
import { loadFunnel } from '../reading/model.ts';
import type { OpeningsFunnel } from '../reading/model.ts';

export type { RuleCard };

// ---------------------------------------------------------------- loaders

export async function loadRules(): Promise<Sourced<RuleCard[]>> {
  let res: Response;
  try { res = await fetch('/api/rules'); } catch { throw new Error('the DOMINO server isn’t answering on /api'); }
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('this server has no rules registry (GET /api/rules)');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { data: await res.json() as RuleCard[], source: 'live', evidence: [] };
}

export const useRules = () => useQuery<RuleCard[]>('rules', loadRules);
export const useFunnel = () => useQuery<OpeningsFunnel>('openings-funnel', loadFunnel);

/** The dossier may 404 for a company no run contains; the page shows what it has. */
export function useDossier(companyId: string) {
  return useQuery<CompanyDossier>(`dossier:${companyId}`, () => deskApi.dossier(companyId));
}

/**
 * A decision a guard held today, for the guard card. The current company's own held opening if it has one;
 * otherwise the first acqui-hire row in the funnel's held stage, resolved to its company file.
 */
export function useHeldExample(desk: CompanyDesk) {
  const own = desk.openings.find((o) => o.status === 'held' && guardClause(o));
  const funnel = useFunnel();
  const companies = useQuery<CompanySummary[]>('companies', () => deskApi.companies());
  const held = funnel.data?.stages.find((s) => s.id === 'held');
  const rows = [...(held?.rows ?? [])].sort((a, b) => Number(/acqui-hire/i.test(b.detail ?? '')) - Number(/acqui-hire/i.test(a.detail ?? '')));
  const name = rows[0]?.label.split(' · ')[0];
  const id = own ? null : companies.data?.find((c) => c.name === name)?.id ?? null;
  const other = useQuery<CompanyDesk>(id ? `company:${id}` : null, () => deskApi.company(id!));
  const source = own ? desk : other.data;
  const opening = own ?? other.data?.openings.find((o) => o.status === 'held' && guardClause(o)) ?? null;
  return {
    opening,
    evidence: source?.evidence ?? [],
    heldRows: rows,
    loading: !own && (funnel.loading || other.loading) && !opening,
    error: own ? null : funnel.error ?? other.error,
  };
}

// ---------------------------------------------------------------- wording

/** "22 Nov 2026 14:08 IST, after seeing …" -> { short: "Locked 22 Nov, 14:08 IST", rest: "After seeing …" } */
export function lockParts(lockedAt: string): { short: string; rest: string } {
  const m = lockedAt.match(/^(\d{1,2}) (\w{3}) \d{4},? (\d{1,2}:\d{2}) IST/);
  if (!m) return { short: `Locked ${lockedAt}`, rest: '' };
  const rest = lockedAt.slice(m[0].length).replace(/^[\s,;]+/, '');
  return { short: `Locked ${m[1]} ${m[2]}, ${m[3]} IST`, rest: rest ? rest[0].toUpperCase() + rest.slice(1) : '' };
}

export const familyShort = (f: string | null | undefined) =>
  f ? (ROLE_FAMILY_LABELS[f as keyof typeof ROLE_FAMILY_LABELS] ?? f).split(' / ')[0] : 'one role family';

const ORD = ['zeroth', '1st', '2nd', '3rd', '4th', '5th'];
export const ordinal = (n: number) => ORD[n] ?? `${n}th`;

export type Chip = { cls: string; label: string };

export function ruleStateChip(state: DossierRule['state']): Chip {
  switch (state) {
    case 'met': return { cls: 'st verified', label: 'Met' };
    case 'open': return { cls: 'st prov', label: 'Provisional' };
    case 'held': return { cls: 'st held', label: 'Held' };
    case 'not_met': return { cls: 'st plain', label: 'Not met' };
    default: return { cls: 'st plain faint', label: 'Not evaluated' };
  }
}

export function openingChip(o: Opening): Chip {
  const l = openingLabel(o);
  if (l === 'held') return { cls: 'st held', label: `Held: ${guardLabel(guardClause(o)?.id)}` };
  if (l === 'provisional') return { cls: 'st prov', label: `Provisional: window closes by ${fmtDate(o.windowClosesBy, true)}` };
  if (l === 'watch') return { cls: 'st plain', label: 'Watch' };
  return { cls: 'st verified', label: 'Predicted opening' };
}

const GUARD_NAMES: Record<string, string> = {
  'guard.acquihire': 'acqui-hire', 'guard.restructure': 'possible restructure', 'guard.parent': 'shared parent',
  'guard.size': 'company size', 'guard.share': 'over 40% moving', 'guard.identity': 'ambiguous company id',
};
export const guardLabel = (id: string | undefined) => (id && GUARD_NAMES[id]) ?? (id ? id.replace(/^guard\./, '').replace(/_/g, ' ') : 'guard');

/** The guard that held an opening: acqui-hire first, then any other failed guard. */
export function guardClause(o: Opening): RuleClause | undefined {
  const failed = (o.clauses ?? []).filter((c) => c.id.startsWith('guard.') && c.state === 'failed');
  return failed.find((c) => c.id === 'guard.acquihire') ?? failed[0];
}

/** "2 of 3 conclusive departures" -> { have: 2, need: 3 } */
export function watchCount(rule: DossierRule | undefined): { have: number; need: number; clause: RuleClause } | null {
  if (!rule) return null;
  for (const c of rule.clauses) {
    const m = c.text.match(/(\d+) of (\d+)/);
    if (m) return { have: Number(m[1]), need: Number(m[2]), clause: c };
  }
  return null;
}

/** "(Oct, Oct)" from "2 conclusive ML platform departures (Oct, Oct); O1 needs 2" */
export const clauseMonths = (c: RuleClause | undefined) => c?.text.match(/\(([A-Z][a-z]{2}(?:, [A-Z][a-z]{2})*)\)/)?.[1] ?? null;

/** True when the O1/R1 clause detail names this destination as not conclusive (month straddles the window). */
export function notConclusive(detail: string | undefined, to: string | null): string | null {
  if (!detail || !to) return null;
  const at = detail.indexOf(`→ ${to}: not conclusive`);
  if (at < 0) return null;
  return detail.slice(at + `→ ${to}: `.length).split('.')[0];
}

// ---------------------------------------------------------------- evidence

export function evidenceMap(...lists: (Evidence[] | undefined)[]): Map<string, Evidence> {
  const m = new Map<string, Evidence>();
  for (const l of lists) for (const e of l ?? []) if (!m.has(e.id)) m.set(e.id, e);
  return m;
}

/** Month-precision records stay months ("Sep 2026"); day records show the day. */
export function evDate(e: Evidence | undefined): string {
  if (!e?.observedAt) return 'undated';
  return /month precision|month-level/i.test(e.claim) ? fmtDate(e.observedAt.slice(0, 7)) : fmtDate(e.observedAt, true);
}

export function evSource(e: Evidence | undefined): string {
  if (!e) return 'no source';
  if (e.source.url && !/linkedin\.com\/in\//.test(e.source.url)) {
    try { return new URL(e.source.url).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  const ep = (e.source.endpoint ?? '').replace(/^\//, '');
  return e.source.provider === 'crustdata' ? `Crustdata ${ep}` : `${e.source.provider} ${ep}`.trim();
}

// ---------------------------------------------------------------- verifier claims

export type ClaimState = 'verified' | 'open' | 'not_met' | 'guard' | 'cant' | 'removed' | 'not_evaluated';
export const CLAIM_LABEL: Record<ClaimState, string> = {
  verified: 'Verified', open: 'Open', not_met: 'Not met', guard: 'Guard matched', cant: 'I can’t verify',
  removed: 'Removed', not_evaluated: 'Not evaluated',
};
export interface ClaimRow { key: string; state: ClaimState; text: string; reason?: string; detail?: string; evidenceIds: string[] }
export interface ClaimGroup { key: string; rule: string; title: string; chip: Chip; rows: ClaimRow[] }

function clauseRow(c: RuleClause, key: string): ClaimRow {
  const state: ClaimState = c.state === 'met' ? 'verified' : c.state === 'open' ? 'open' : c.state === 'cant_verify' ? 'cant'
    : c.id.startsWith('guard.') ? 'guard' : 'not_met';
  return { key, state, text: c.text, detail: c.detail, reason: c.state === 'cant_verify' ? c.detail : undefined, evidenceIds: c.evidenceIds };
}

/** Every claim behind this company's decisions, grouped by the decision it supports. */
export function claimGroups(desk: CompanyDesk, dossier: CompanyDossier | null): ClaimGroup[] {
  const groups: ClaimGroup[] = [];
  for (const o of desk.openings) {
    groups.push({
      key: `op:${o.id}`, rule: 'O1', title: o.roleTitle, chip: openingChip(o),
      rows: (o.clauses ?? []).map((c, i) => clauseRow(c, `${o.id}:${c.id}:${i}`)),
    });
  }
  for (const r of dossier?.rules ?? []) {
    if (r.id === 'O1' && desk.openings.length) continue; // the O1 clauses are already listed per opening
    const rows = r.clauses.map((c, i) => clauseRow(c, `${r.id}:${c.id}:${i}`));
    if (!rows.length) rows.push({ key: `${r.id}:summary`, state: r.state === 'not_evaluated' ? 'not_evaluated' : r.state === 'not_met' ? 'not_met' : 'open', text: r.summary, evidenceIds: [] });
    groups.push({ key: `rule:${r.id}`, rule: r.id, title: r.name, chip: ruleStateChip(r.state), rows });
  }
  for (const m of desk.matches) {
    const op = desk.openings.find((o) => o.id === m.openingId);
    groups.push({
      key: `match:${m.candidateId}:${m.openingId}`, rule: 'Match', title: `${m.candidateLabel} for ${op?.roleTitle ?? 'this opening'}`,
      chip: { cls: 'st plain', label: `${m.fit.filter((f) => f.status === 'verified').length} of ${m.fit.length} verified` },
      rows: m.fit.map((f, i) => {
        const [head, ...tail] = f.text.split(': ');
        const cant = f.status === 'cant_verify';
        return {
          key: `${m.candidateId}:${i}`, state: cant ? 'cant' : 'verified', text: cant && tail.length ? head : f.text,
          reason: cant ? (tail.join(': ') || 'no dated source') : undefined,
          detail: !cant && !f.evidenceId && f.profileField ? `Consented profile field: ${f.profileField}` : undefined,
          evidenceIds: f.evidenceId ? [f.evidenceId] : [],
        } satisfies ClaimRow;
      }),
    });
  }
  (dossier?.outreach ?? []).forEach((o, i) => {
    const rows: ClaimRow[] = [
      ...o.verifier.removed.map((t, j) => ({ key: `out${i}:rm${j}`, state: 'removed' as const, text: t, reason: 'contradicted or undated, removed from the draft', evidenceIds: [] })),
      ...o.verifier.cantVerify.map((c, j) => ({ key: `out${i}:cv${j}`, state: 'cant' as const, text: c.claim, reason: c.reason, evidenceIds: [] })),
    ];
    if (rows.length) groups.push({ key: `out:${i}`, rule: 'Outreach', title: 'Draft claims', chip: { cls: 'st plain', label: o.verifier.verified ? 'Draft verified' : 'Draft not verified' }, rows });
  });
  return groups;
}
