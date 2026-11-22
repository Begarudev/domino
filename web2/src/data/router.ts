// A tiny pushState router. "/" is the sign-in (role chosen once). Candidate: /candidate, /candidate/onboard.
// Company: /company (pick), /company/:id/:tab. Query params (mode, run, speed) survive navigation.
import { useSyncExternalStore } from 'react';

// Company navigation, from the approved design mock: Act (Recruitment, Outreach), Read (Reading log, Company file,
// Chains, Verifier), Check (Replay, Ledger).
export type CompanyTab = 'recruitment' | 'outreach' | 'reading' | 'file' | 'chains' | 'verifier' | 'replay' | 'ledger';
export type TabGroup = 'Act' | 'Read' | 'Check';
export const COMPANY_TABS: { id: CompanyTab; label: string; group: TabGroup; hint: string }[] = [
  { id: 'recruitment', label: 'Recruitment', group: 'Act', hint: 'Who left, what that predicts, and who you can hire. People appear as role and initial.' },
  { id: 'outreach', label: 'Outreach', group: 'Act', hint: 'A footnoted draft, your approval, then delivered once.' },
  { id: 'reading', label: 'Reading log', group: 'Read', hint: 'Every record the run read, kept or discarded, and why.' },
  { id: 'file', label: 'Company file', group: 'Read', hint: 'Dated facts, headcount, talent flows and the rules that apply. No generated prose.' },
  { id: 'chains', label: 'Chains', group: 'Read', hint: 'Rules that link a move at one company to a need at another, with today’s fire counts.' },
  { id: 'verifier', label: 'Verifier', group: 'Read', hint: 'Each claim checked against a dated source, or marked “I can’t verify”.' },
  { id: 'replay', label: 'Replay', group: 'Check', hint: 'The rules run on 1 Sep data, scored against what happened next.' },
  { id: 'ledger', label: 'Ledger', group: 'Check', hint: 'Every paid call against the run’s caps.' },
];
/** Tabs whose feature is built. Unbuilt tabs are hidden, never shown as stubs. */
export const BUILT_TABS = new Set<CompanyTab>(['recruitment', 'reading']);

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
