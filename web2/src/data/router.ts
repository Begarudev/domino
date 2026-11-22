// A tiny pushState router. "/" is the sign-in (role chosen once). Candidate: /candidate, /candidate/onboard.
// Company: /company (pick), /company/:id/:tab. Query params (mode, run, speed) survive navigation.
import { useSyncExternalStore } from 'react';

export type CompanyTab = 'openings' | 'matches' | 'rundesk' | 'file' | 'rules' | 'outreach' | 'replay' | 'ledger';
export type TabGroup = 'Predict' | 'Act';
export const COMPANY_TABS: { id: CompanyTab; label: string; group: TabGroup; hint: string }[] = [
  { id: 'openings', label: 'Openings and talent drain', group: 'Predict', hint: 'Rule O1 over dated job moves: who left, and what that opens' },
  { id: 'file', label: 'Company file', group: 'Predict', hint: 'Dated facts, headcount, talent flows and the rules that fired' },
  { id: 'rules', label: 'Rules and verifier', group: 'Predict', hint: 'Every rule, its thresholds, and today’s live fire count' },
  { id: 'replay', label: 'Replay', group: 'Predict', hint: 'The rules run on 1 Sep data, scored against what happened' },
  { id: 'matches', label: 'Matched candidates', group: 'Act', hint: 'Opted-in candidates, fit checked field by field' },
  { id: 'rundesk', label: 'Run desk', group: 'Act', hint: 'Start a live run and watch every read it keeps or discards' },
  { id: 'outreach', label: 'Outreach', group: 'Act', hint: 'Footnoted draft, approve, delivered once' },
  { id: 'ledger', label: 'Ledger', group: 'Act', hint: 'Every paid call against the caps' },
];
/** Tabs whose feature is built. Unbuilt tabs are hidden, never shown as stubs. */
export const BUILT_TABS = new Set<CompanyTab>(['openings']);

const ALIASES: Record<string, CompanyTab> = { drain: 'openings', analysis: 'file', needs: 'file', chains: 'rules', reading: 'rundesk' };

export type Route =
  | { page: 'login' }
  | { page: 'candidate'; sub: 'onboard' | 'dashboard' }
  | { page: 'companies' }
  | { page: 'company'; id: string; tab: CompanyTab };

export function parse(pathname: string): Route {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts[0] === 'company') {
    if (!parts[1]) return { page: 'companies' };
    const raw = parts[2] ?? 'openings';
    const tab = (COMPANY_TABS.find((t) => t.id === raw)?.id ?? ALIASES[raw] ?? 'openings') as CompanyTab;
    return { page: 'company', id: decodeURIComponent(parts[1]), tab };
  }
  if (parts[0] === 'candidate') return { page: 'candidate', sub: parts[1] === 'onboard' ? 'onboard' : 'dashboard' };
  return { page: 'login' };
}

export function href(r: Route): string {
  const q = location.search;
  switch (r.page) {
    case 'login': return `/${q}`;
    case 'candidate': return `/candidate${r.sub === 'onboard' ? '/onboard' : ''}${q}`;
    case 'companies': return `/company${q}`;
    case 'company': return `/company/${encodeURIComponent(r.id)}/${r.tab}${q}`;
  }
}

const listeners = new Set<() => void>();
let current = parse(location.pathname);
window.addEventListener('popstate', () => { current = parse(location.pathname); listeners.forEach((f) => f()); });

export function navigate(r: Route, replace = false) {
  const url = href(r);
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  current = parse(location.pathname);
  listeners.forEach((f) => f());
  document.getElementById('main')?.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => current);
}

/** "Abacus.AI" -> "abacus-ai" (company routes accept either the id or this slug) */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
