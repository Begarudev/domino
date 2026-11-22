// What today's openings scan read, for the candidate dashboard: the funnel (GET /api/openings/funnel), the company
// list (GET /api/companies) and up to 12 company files (GET /api/companies/:id). Read-only GETs, never a scan or a run.
import { useEffect, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import { ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import type { CompanySummary, Departure, RoleFamily } from '../../data/desk.ts';
import { fmtDate, fmtInt, plural } from '../../lib/format.ts';
import type { OpeningX } from '../onboarding/contract.ts';

export interface FunnelRow { label: string; detail?: string; evidenceId?: string }
export interface FunnelStage { id: string; label: string; count: number; rows?: FunnelRow[] }
export interface FunnelX {
  runId: string; rule: string; lockedAt?: string; stages: FunnelStage[];
  served?: { label?: string; readFrom?: string; readTo?: string; credits?: number };
}
interface CompanyFile { company: CompanySummary; departures: Departure[]; openings: OpeningX[]; evidence: Evidence[] }
export interface Scan {
  funnel: FunnelX | null; companies: CompanySummary[]; files: CompanyFile[];
  loading: boolean; error: string | null;
}

const MAX_FILES = 12;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`${url} answered ${res.status}`);
  const j = await res.json() as T | { data: T };
  return (j && typeof j === 'object' && 'data' in (j as object) && !Array.isArray(j) ? (j as { data: T }).data : j) as T;
}

/** Companies worth opening: any with an opening or a hold, then the ones with the most departures, inside O1's 20–5,000 band. */
function pick(cs: CompanySummary[], funnel: FunnelX | null): CompanySummary[] {
  // Companies the rule stages name ("Poolside · inference", "P. ML Platform Engineer · Abacus.AI · left Oct 2026 → …").
  const named = new Set<string>();
  for (const id of ['groups', 'provisional', 'open', 'held', 'watch']) {
    for (const r of stage(funnel, id)?.rows ?? []) {
      const parts = r.label.split(' · ');
      named.add((id === 'groups' ? parts[1] : parts[0])?.trim() ?? '');
    }
  }
  const band = (c: CompanySummary) => (c.headcount ?? 0) >= 20 && (c.headcount ?? 0) <= 5000;
  const score = (c: CompanySummary) => (c.openings ? 1000 : 0) + ((c.held ?? 0) || named.has(c.name) ? 500 : 0) + c.departures90d;
  return cs.filter((c) => c.openings > 0 || (c.held ?? 0) > 0 || named.has(c.name) || (band(c) && c.departures90d >= 1)).sort((a, b) => score(b) - score(a)).slice(0, MAX_FILES);
}

export function useScan(): Scan {
  const [s, set] = useState<Scan>({ funnel: null, companies: [], files: [], loading: true, error: null });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [funnel, companies] = await Promise.all([
          getJson<FunnelX>('/api/openings/funnel').catch(() => null),
          getJson<CompanySummary[]>('/api/companies'),
        ]);
        if (!alive) return;
        set((p) => ({ ...p, funnel, companies }));
        const files = (await Promise.all(pick(companies, funnel).map((c) =>
          getJson<Omit<CompanyFile, 'company'> & { company?: CompanySummary }>(`/api/companies/${encodeURIComponent(c.id)}`)
            .then((f) => ({ company: c, departures: f.departures ?? [], openings: (f.openings ?? []) as OpeningX[], evidence: f.evidence ?? [] }))
            .catch(() => null)))).filter((f): f is CompanyFile => !!f);
        if (alive) set((p) => ({ ...p, files, loading: false }));
      } catch (e) {
        if (alive) set((p) => ({ ...p, loading: false, error: (e as Error).message }));
      }
    })();
    return () => { alive = false; };
  }, []);
  return s;
}

export const stage = (f: FunnelX | null, id: string) => f?.stages.find((x) => x.id === id) ?? null;

/** The role families the scan actually covered: every family seen in a departure or an opening it read. */
export function scannedFamilies(files: CompanyFile[]): RoleFamily[] {
  const seen = new Set<RoleFamily>();
  for (const f of files) { f.departures.forEach((d) => { if (d.roleFamily) seen.add(d.roleFamily); }); f.openings.forEach((o) => seen.add(o.roleFamily)); }
  return (Object.keys(ROLE_FAMILY_LABELS) as RoleFamily[]).filter((k) => seen.has(k));
}

export interface WatchItem {
  key: string; companyId: string; companyName: string; headcount: number; family: RoleFamily;
  departures: Departure[]; status: 'counting' | 'watch' | 'held'; note: string | null;
}

/** Company and family pairs short of a predicted opening: one dated departure (1 of 2), or 2+ held or on watch. */
export function watchlist(files: CompanyFile[]): WatchItem[] {
  const out: WatchItem[] = [];
  for (const f of files) {
    const byFam = new Map<RoleFamily, Departure[]>();
    for (const d of f.departures) if (d.roleFamily) byFam.set(d.roleFamily, [...(byFam.get(d.roleFamily) ?? []), d]);
    for (const [family, deps] of byFam) {
      const op = f.openings.find((o) => o.roleFamily === family);
      if (op?.status === 'open') continue; // a predicted opening, shown as an opening, not a watch
      const status = op?.status === 'held' ? 'held' : op?.status === 'watch' ? 'watch' : deps.length >= 2 ? 'watch' : 'counting';
      const note = op?.status === 'held' ? (op.holdReasons?.[0] ?? null) : op?.watch?.reason ?? null;
      out.push({ key: `${f.company.id}:${family}`, companyId: f.company.id, companyName: f.company.name, headcount: f.company.headcount ?? 0,
        family, departures: [...deps].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")), status, note });
    }
  }
  const order = { watch: 0, held: 1, counting: 2 } as const;
  return out.sort((a, b) => Math.min(b.departures.length, 2) - Math.min(a.departures.length, 2) || order[a.status] - order[b.status]);
}

/** "P., ML Platform Engineer · left Oct 2026 for Arcfront" (month precision never shows a day). */
export const departureLine = (d: Departure) =>
  `${d.initial} ${d.role} · left ${d.precision === "month" && d.date ? fmtDate(d.date.slice(0, 7)) : fmtDate(d.date, true)}${d.toCompanyName ? ` for ${d.toCompanyName}` : ''}`;

export const countWord = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
export { plural };
