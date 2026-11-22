// A tiny pushState router: /candidate, /candidate/onboard, /company, /company/:id/:tab. Query params (mode, run,
// speed) survive navigation so a labelled sample or mock session stays labelled.
import { useSyncExternalStore } from 'react';

export type CompanyTab = 'drain' | 'openings' | 'matches' | 'analysis' | 'outreach' | 'ledger' | 'replay';
export const COMPANY_TABS: { id: CompanyTab; label: string }[] = [
  { id: 'openings', label: 'Predicted openings' },
  { id: 'drain', label: 'Talent drain' },
  { id: 'matches', label: 'Matched candidates' },
  { id: 'analysis', label: 'Company analysis' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'replay', label: 'Replay' },
];

export type Route =
  | { page: 'candidate'; sub: 'onboard' | 'dashboard' }
  | { page: 'companies' }
  | { page: 'company'; id: string; tab: CompanyTab };

export function parse(pathname: string): Route {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts[0] === 'company') {
    if (!parts[1]) return { page: 'companies' };
    const tab = (COMPANY_TABS.find((t) => t.id === parts[2])?.id ?? 'openings') as CompanyTab;
    return { page: 'company', id: decodeURIComponent(parts[1]), tab };
  }
  if (parts[0] === 'candidate' && parts[1] === 'onboard') return { page: 'candidate', sub: 'onboard' };
  return { page: 'candidate', sub: 'dashboard' };
}

export function href(r: Route): string {
  const q = location.search;
  switch (r.page) {
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
  window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => current);
}

/** "Abacus.AI" -> "abacus-ai" (company routes accept either the id or this slug) */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
