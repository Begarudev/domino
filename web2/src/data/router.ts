// A tiny pushState router. "/" is the sign-in (role chosen once). Candidate: /candidate, /candidate/onboard.
// Company: /company (pick), /company/:id/:tab. Query params (mode, run, speed) survive navigation.
import { useSyncExternalStore } from 'react';

// Company navigation, from the approved design mock: Act (Recruitment, Outreach), Read (Reading log, Company file,
// Chains, Verifier), Check (Replay, Ledger).
export type CompanyTab = 'recruitment' | 'buyers' | 'outreach' | 'reading' | 'file' | 'chains' | 'verifier' | 'replay' | 'ledger';
export type TabGroup = 'Act' | 'Read' | 'Check';
export const COMPANY_TABS: { id: CompanyTab; label: string; group: TabGroup; hint: string }[] = [
  { id: 'recruitment', label: 'Hire', group: 'Act', hint: 'Openings a rule predicts at this company from dated departures, and opted-in people you could hire for them.' },
  { id: 'buyers', label: 'Find buyers', group: 'Act', hint: 'Companies whose dated moves predict they need what you sell, and the role that decides. Nothing is sent without you.' },
  { id: 'outreach', label: 'Outreach', group: 'Act', hint: 'Each draft with its footnoted sources. You approve it, then it is delivered once; nothing goes out without you.' },
  { id: 'reading', label: 'Reading log', group: 'Read', hint: 'Every record DOMINO read for this decision, and why it kept or dropped it.' },
  { id: 'file', label: 'Company file', group: 'Read', hint: 'Everything known about this company as dated, sourced facts: headcount, who joined and left, and which rules apply.' },
  { id: 'chains', label: 'Chains', group: 'Read', hint: 'The rules that turn a move at one company into a need at another, and which ones fired or held today.' },
  { id: 'verifier', label: 'Verifier', group: 'Read', hint: 'Every claim behind a decision, checked against a dated source. What can’t be checked is shown, not hidden.' },
  { id: 'replay', label: 'Replay', group: 'Check', hint: 'Whether rule O1 would have been right: data frozen at 1 Sep, then compared with what actually happened next.' },
  { id: 'ledger', label: 'Ledger', group: 'Check', hint: 'Every data call this run made, what it cost, and the limits that cap it.' },
];
/** Tabs whose feature is built. Unbuilt tabs are hidden, never shown as stubs. */
export const BUILT_TABS = new Set<CompanyTab>(['recruitment', 'buyers', 'outreach', 'reading', 'file', 'chains', 'verifier', 'replay', 'ledger']);

const ALIASES: Record<string, CompanyTab> = {
  openings: 'recruitment', drain: 'recruitment', matches: 'recruitment', analysis: 'file', needs: 'verifier', rules: 'chains', rundesk: 'reading',
};

export type Route =
  | { page: 'login' }
  | { page: 'candidate'; sub: 'onboard' | 'dashboard' }
  | { page: 'companies' }
  | { page: 'company'; id: string; tab: CompanyTab };

export function parse(pathname: string): Route {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts[0] === 'company') {
    if (!parts[1]) return { page: 'companies' };
    const raw = parts[2] ?? 'recruitment';
    const tab = (COMPANY_TABS.find((t) => t.id === raw)?.id ?? ALIASES[raw] ?? 'recruitment') as CompanyTab;
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
