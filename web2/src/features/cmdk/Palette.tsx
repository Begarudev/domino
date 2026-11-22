// Cmd+K command palette: jump to any company (GET /api/companies), any company tab, any run (GET /api/runs, by id or
// label), plus actions (open the reading log for the current run, sign out). Keyboard-first: ↑↓ move, ↵ opens, esc closes.
// Self-contained (no cmdk dependency on main yet); the same listbox + combobox pattern.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { deskApi, useQuery } from '../../data/query.ts';
import { BUILT_TABS, COMPANY_TABS, navigate, slug, useRoute } from '../../data/router.ts';
import type { Route } from '../../data/router.ts';
import { runStore, useRunSel } from '../../data/store.ts';
import { getShell, signOut, useShell } from '../../shell/ui.ts';
import './cmdk.css';

type Item = { id: string; group: 'Actions' | 'Tabs' | 'Companies' | 'Runs'; label: string; meta?: string; keywords: string; run: () => void };
type RunRow = { id: string; request?: string; status?: string; createdAt?: string };

const listeners = new Set<(o: boolean) => void>();
/** Open the palette from anywhere (the top-bar hint calls this). */
export const openPalette = () => listeners.forEach((f) => f(true));

const runKind = (r: string) => r.startsWith('intro:') ? 'Outreach run' : r.startsWith('candidate:') ? 'Profile read'
  : /^Predict openings/i.test(r) ? 'Openings scan' : r ? 'Buyer run' : 'Run';

export function Palette() {
  const role = useShell((s) => s.role);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', on);
    listeners.add(setOpen);
    return () => { window.removeEventListener('keydown', on); listeners.delete(setOpen); };
  }, []);
  if (!open || !role) return null;
  return createPortal(<Dialog onClose={() => setOpen(false)} />, document.body);
}

function Dialog({ onClose }: { onClose: () => void }) {
  const role = useShell((s) => s.role);
  const route = useRoute();
  const runId = useRunSel((v) => v.runId);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const companies = useQuery(role === 'company' ? 'companies' : null, () => deskApi.companies());
  const runs = useQuery<RunRow[] | null>(role === 'company' ? 'cmdk-runs' : null, async () => {
    const r = await fetch('/api/runs').catch(() => null);
    const ok = r && r.ok && (r.headers.get('content-type') ?? '').includes('json');
    return { data: ok ? await r.json() : null, source: 'live', evidence: [] };
  });
  useEffect(() => { input.current?.focus(); }, []);

  const companyId = route.page === 'company' || route.page === 'trace' ? route.id : getShell().companyId ?? null;
  const items = useMemo<Item[]>(() => {
    const go = (r: Route) => () => { onClose(); navigate(r); };
    const out: Item[] = [];
    if (role === 'company') {
      if (companyId) out.push({ id: 'a-reading', group: 'Actions', label: 'Open Reading log for this run', meta: runId ? runId.slice(0, 12) : 'latest scan', keywords: 'reading log run records', run: go({ page: 'company', id: companyId, tab: 'reading' }) });
      if (companyId && runId) out.push({ id: 'a-trace', group: 'Actions', label: 'Open the trace of this run', meta: runId.slice(0, 12), keywords: 'trace pipeline steps', run: go({ page: 'trace', id: companyId, runId }) });
      out.push({ id: 'a-companies', group: 'Actions', label: 'All companies', keywords: 'companies list home', run: go({ page: 'companies' }) });
    }
    if (role === 'candidate') {
      out.push({ id: 'a-open', group: 'Actions', label: 'Openings', keywords: 'dashboard openings', run: go({ page: 'candidate', sub: 'dashboard' }) });
      out.push({ id: 'a-prof', group: 'Actions', label: 'Profile and consent', keywords: 'profile onboard consent', run: go({ page: 'candidate', sub: 'onboard' }) });
    }
    out.push({ id: 'a-out', group: 'Actions', label: 'Sign out', keywords: 'sign out logout', run: () => { onClose(); signOut(); runStore.clear(); navigate({ page: 'login' }); } });
    if (role === 'company' && companyId) {
      for (const t of COMPANY_TABS) if (BUILT_TABS.has(t.id)) out.push({ id: `t-${t.id}`, group: 'Tabs', label: t.label, meta: t.group, keywords: `${t.label} ${t.group} ${t.hint}`, run: go({ page: 'company', id: companyId, tab: t.id }) });
    }
    for (const c of companies.data ?? []) {
      const meta = c.openings ? `O1 · ${c.openings} opening${c.openings === 1 ? '' : 's'}` : c.domain ?? undefined;
      out.push({ id: `c-${c.id}`, group: 'Companies', label: c.name, meta, keywords: `${c.name} ${c.domain ?? ''}`, run: go({ page: 'company', id: slug(c.name), tab: 'recruitment' }) });
    }
    for (const r of runs.data ?? []) {
      const req = r.request ?? '';
      const label = `${runKind(req)} · ${req.replace(/^(intro|candidate):/, '').slice(0, 64) || r.id}`;
      out.push({
        id: `r-${r.id}`, group: 'Runs', label, meta: r.status, keywords: `${r.id} ${req} ${r.status ?? ''}`,
        run: () => { onClose(); if (companyId) navigate({ page: 'trace', id: companyId, runId: r.id }); else void runStore.attach(r.id); },
      });
    }
    return out;
  }, [role, companyId, runId, companies.data, runs.data, onClose]);

  const shown = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = terms.length ? items.filter((i) => terms.every((t) => `${i.label} ${i.keywords}`.toLowerCase().includes(t))) : items;
    // Unfiltered: keep the list short (actions, tabs, first companies, latest runs); typing searches everything.
    if (terms.length) return hit.slice(0, 80);
    const cap: Record<Item['group'], number> = { Actions: 9, Tabs: 12, Companies: 8, Runs: 5 };
    const n: Record<string, number> = {};
    return hit.filter((i) => (n[i.group] = (n[i.group] ?? 0) + 1) <= cap[i.group]);
  }, [items, q]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); shown[sel]?.run(); }
  };

  let last = '';
  return (
    <div className="cmdk-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="cmdk">
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="cmdk-in">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies, tabs, runs or actions…"
            role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-activedescendant={shown[sel] ? `cmdk-${shown[sel].id}` : undefined} data-testid="cmdk-input" />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {!shown.length && <p className="cmdk-empty">Nothing matches “{q}”. Searched {companies.data?.length ?? 0} companies from GET /api/companies and {runs.data?.length ?? 0} runs from GET /api/runs.</p>}
          {shown.map((it, i) => {
            const head = it.group !== last ? (last = it.group) : null;
            return (
              <div key={it.id}>
                {head && <div className="cmdk-grp" role="presentation">{head}</div>}
                <div id={`cmdk-${it.id}`} role="option" aria-selected={i === sel} className="cmdk-item"
                  onMouseMove={() => { if (sel !== i) setSel(i); }} onClick={() => it.run()}>
                  <span className={`cmdk-dot g-${it.group.toLowerCase()}`} aria-hidden />
                  <span className="cmdk-label">{it.label}</span>
                  {it.meta && <span className="cmdk-meta">{it.meta}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </div>
  );
}
