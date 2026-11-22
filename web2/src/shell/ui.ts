// Shell state that isn't run data: who's signed in (role chosen once at login), the drawers, the page's data source.
import { useSyncExternalStore } from 'react';
import type { Provenance } from '../data/desk.ts';

export type Role = 'candidate' | 'company';

export interface ShellState {
  role: Role | null;
  candidateId: string | null;
  candidateLabel: string | null;
  companyId: string | null;          // the signed-in company (slug or co_ id)
  companyName: string | null;
  ledgerOpen: boolean;
  evidenceId: string | null;
  /** where the current page's facts came from; the top bar shows one truthful pill from it */
  pageSource: Provenance | null;
}

const KEY = 'domino.v2.session';
type Saved = Pick<ShellState, 'role' | 'candidateId' | 'candidateLabel' | 'companyId' | 'companyName'>;
const saved: Partial<Saved> = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{}'); } catch { return {}; } })();

let state: ShellState = {
  role: saved.role ?? null, candidateId: saved.candidateId ?? null, candidateLabel: saved.candidateLabel ?? null,
  companyId: saved.companyId ?? null, companyName: saved.companyName ?? null,
  ledgerOpen: false, evidenceId: null, pageSource: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<ShellState>) {
  state = { ...state, ...patch };
  const { role, candidateId, candidateLabel, companyId, companyName } = state;
  sessionStorage.setItem(KEY, JSON.stringify({ role, candidateId, candidateLabel, companyId, companyName }));
  listeners.forEach((f) => f());
}

export const getShell = () => state;
export function useShell<T>(sel: (s: ShellState) => T): T {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => sel(state));
}

export const openLedger = () => set({ ledgerOpen: true });
export const closeLedger = () => set({ ledgerOpen: false });
export const openEvidence = (evidenceId: string) => set({ evidenceId });
export const closeEvidence = () => set({ evidenceId: null });
export const setPageSource = (pageSource: Provenance | null) => { if (state.pageSource !== pageSource) set({ pageSource }); };

export const signInCandidate = () => set({ role: 'candidate' });
export const signInCompany = (companyId: string, companyName: string) => set({ role: 'company', companyId, companyName });
export function setCandidate(id: string | null, label?: string | null) {
  set({ role: 'candidate', candidateId: id, candidateLabel: label ?? state.candidateLabel });
}
export function signOut() {
  set({ role: null, candidateId: null, candidateLabel: null, companyId: null, companyName: null, ledgerOpen: false, evidenceId: null });
}
