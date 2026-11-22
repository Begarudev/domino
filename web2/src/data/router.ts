// A tiny pushState router: /candidate, /candidate/onboard, /company, /company/:id/:tab. Query params (mode, run,
// speed) survive navigation so a labelled sample or mock session stays labelled.
import { useSyncExternalStore } from 'react';

export type CompanyTab =
  | 'openings' | 'drain' | 'matches'
  | 'reading' | 'analysis' | 'chains' | 'needs' | 'outreach'
  | 'replay' | 'ledger';
export type TabGroup = 'Hiring' | 'DOMINO workflows' | 'Proof';
export const COMPANY_TABS: { id: CompanyTab; label: string; group: TabGroup; hint: string }[] = [
  { id: 'openings', label: 'Predicted openings', group: 'Hiring', hint: 'Roles likely to open, with dated reasons' },
  { id: 'drain', label: 'Talent drain', group: 'Hiring', hint: 'Who left, for where, and when' },
  { id: 'matches', label: 'Matched candidates', group: 'Hiring', hint: 'Opted-in candidates with sourced fit' },
  { id: 'reading', label: 'Reading desk', group: 'DOMINO workflows', hint: 'News, job posts and company records as they’re read' },
  { id: 'analysis', label: 'Company dossier', group: 'DOMINO workflows', hint: 'Timeline, headcount, funding, talent flows' },
  { id: 'chains', label: 'Cross-company chains', group: 'DOMINO workflows', hint: 'How one company’s move creates another’s need' },
  { id: 'needs', label: 'Predicted needs', group: 'DOMINO workflows', hint: 'Each claim verified, or marked “I can’t verify”' },
  { id: 'outreach', label: 'Outreach', group: 'DOMINO workflows', hint: 'Sourced draft, approve, send once' },
  { id: 'replay', label: 'Replay', group: 'Proof', hint: 'Predictions from 1 Sep against what happened' },
  { id: 'ledger', label: 'Ledger', group: 'Proof', hint: 'Every paid call, against the caps' },
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
