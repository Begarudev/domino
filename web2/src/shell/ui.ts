// Shell UI state that isn't run data: the ledger drawer, the evidence drawer, the signed-in candidate.
import { useSyncExternalStore } from 'react';

export interface ShellState {
  ledgerOpen: boolean;
  evidenceId: string | null;          // open the evidence drawer on one source
  candidateId: string | null;
}

const KEY = 'domino.v2.candidateId';
let state: ShellState = { ledgerOpen: false, evidenceId: null, candidateId: localStorage.getItem(KEY) };
const listeners = new Set<() => void>();
function set(patch: Partial<ShellState>) {
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
}

export function useShell<T>(sel: (s: ShellState) => T): T {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => sel(state));
}

export const openLedger = () => set({ ledgerOpen: true });
export const closeLedger = () => set({ ledgerOpen: false });
export const openEvidence = (evidenceId: string) => set({ evidenceId });
export const closeEvidence = () => set({ evidenceId: null });
export function setCandidate(id: string | null) {
  if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY);
  set({ candidateId: id });
}
