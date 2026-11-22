// Top bar (design mock): mark; candidate tabs on the candidate side; the run chip on the company side (run id, how
// its data was read, when); the account menu with theme and sign out. Each role sees only its own chrome.
import { useEffect, useRef, useState } from 'react';
import { href, navigate, useRoute } from '../data/router.ts';
import type { Route } from '../data/router.ts';
import { useQuery } from '../data/query.ts';
import { runStore, useRunSel } from '../data/store.ts';
import { fmtDate, fmtTime } from '../lib/format.ts';
import { getShell, signOut, useShell } from './ui.ts';

export function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <rect x="2" y="3" width="6.5" height="16" rx="1.2" fill="var(--ink)" />
      <rect x="11.5" y="3" width="6.5" height="16" rx="1.2" fill="none" stroke="var(--ink)" strokeWidth="1.5" transform="rotate(16 14.75 19)" />
      <circle cx="5.25" cy="7.5" r="1" fill="var(--canvas)" />
      <circle cx="5.25" cy="14.5" r="1" fill="var(--canvas)" />
    </svg>
  );
}

export function TopBar({ minimal = false }: { minimal?: boolean }) {
  const role = useShell((s) => s.role);
  const route = useRoute();
  const home = () => {
    const s = getShell();
    navigate(s.role === 'company' ? (s.companyId ? { page: 'company', id: s.companyId, tab: 'recruitment' } : { page: 'companies' }) : s.role === 'candidate' ? { page: 'candidate', sub: 'dashboard' } : { page: 'login' });
  };
  return (
    <header className="bar" data-testid="topbar">
      <a className="mark" href="/" onClick={(e) => { e.preventDefault(); home(); }}><Mark />DOMINO</a>
      {!minimal && role === 'candidate' && <CandidateTabs route={route} />}
      {!minimal && role === 'company' && <RunChip />}
      <div className="bar-spacer" />
      {!minimal && <Account />}
    </header>
  );
}

function CandidateTabs({ route }: { route: Route }) {
  const sub = route.page === 'candidate' ? route.sub : null;
  const tab = (to: Route, label: string, on: boolean, id: string) => (
    <a href={href(to)} aria-current={on ? 'page' : undefined} data-testid={`ctab-${id}`}
      onClick={(e) => { e.preventDefault(); navigate(to); }}>{label}</a>
  );
  return (
    <nav className="bar-tabs" aria-label="Candidate">
      {tab({ page: 'candidate', sub: 'onboard' }, 'Profile', sub === 'onboard', 'profile')}
      {tab({ page: 'candidate', sub: 'dashboard' }, 'Openings', sub === 'dashboard', 'openings')}
    </nav>
  );
}

/** The run behind the page: id, how its data was read (live / cached / fixture / recorded), and when. */
function RunChip() {
  const runId = useRunSel((v) => v.runId);
  const mode = useRunSel((v) => v.mode);
  const status = useRunSel((v) => v.ui.snap.status);
  const dataMode = useRunSel((v) => v.ui.snap.dataMode);
  const created = useRunSel((v) => v.ui.snap.createdAt);
  const request = useRunSel((v) => v.ui.snap.request) ?? '';
  // Name the run, so the chip changing between tabs reads as intentional (each tab shows the run behind it).
  const kind = request.startsWith('intro:') ? 'Outreach run' : request.startsWith('candidate:') ? 'Profile read'
    : /^Predict openings/i.test(request) ? 'Openings scan' : request ? 'Buyer run' : 'Run';
  const page = useShell((s) => s.pageSource);
  const companyId = useShell((s) => s.companyId);
  const running = status === 'running' || status === 'queued';
  // The engine's own sentence for how the scan was read ("Live Crustdata read 22 Nov, 14:30–14:34 IST · replayed from
  // the recorded cache (0 credits)") beats our guess from dataMode.
  const funnel = useQuery<{ runId?: string; served?: { label?: string } } | null>('funnel', async () => {
    const r = await fetch('/api/openings/funnel').catch(() => null);
    const ok = r && r.ok && (r.headers.get('content-type') ?? '').includes('json');
    return { data: ok ? await r.json() : null, source: 'live', evidence: [] };
  });
  const servedRaw = funnel.data?.runId === runId ? funnel.data?.served?.label : undefined;
  // "Snapshot · Crustdata read 22 Nov, 14:30–14:34 IST · 0 new credits": never "live" beside "replayed".
  const served = servedRaw ? servedRaw.replace(/^Live\s+/i, '').replace(/\s*·?\s*replayed from the recorded cache \(0 credits\)/i, ' · 0 new credits') : undefined;
  let how = dataMode === 'cache' ? 'cached live' : dataMode === 'fixture' ? 'fixture' : 'live';
  if (mode === 'sample') how = 'recorded';
  if (mode === 'mock') how = 'mock';
  if (!runId) {
    return <span className="runchip" title="No run behind this page" data-testid="run-chip"><span className="dot idle" />{page === 'fixture' ? 'snapshot of today’s scan' : 'Loading the latest scan…'}</span>;
  }
  return (
    <a className="runchip" data-testid="run-chip" title={`Run ${runId}${served ? ` · ${served}` : ''}. Open its reading log.`} href={companyId ? href({ page: 'company', id: companyId, tab: 'reading' }) : '#'}
      onClick={(e) => { e.preventDefault(); if (companyId) navigate({ page: 'company', id: companyId, tab: 'reading' }); }}>
      <span className={`dot${running ? ' run' : ''}`} />
      {served && !running ? `Snapshot · ${kind} · ${served}` : `${kind} · `}{served && !running ? '' : running ? 'running' : how === 'recorded' ? 'recorded' : how === 'mock' ? 'mock' : how === 'fixture' ? 'fixture' : how === 'cached live' ? 'cached live' : 'live'}
      {!served && created ? ` · ${fmtDate(created)}, ${fmtTime(created)} IST` : ''}
    </a>
  );
}

/** Signed-in identity and the only way to change role: sign out. */
function Account() {
  const s = useShell((x) => x);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!s.role) return null;
  const who = s.role === 'company' ? s.companyName ?? 'Company' : s.candidateLabel ?? 'Candidate';
  const initial = who.trim()[0]?.toUpperCase() ?? '?';
  return (
    <div className="acct" ref={ref}>
      <button className="acct-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" data-testid="account">
        <span className="acct-av" aria-hidden>{initial}</span>
        <span className="acct-who">{who}</span>
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-line"><b>{who}</b>{s.role === 'company' ? 'Company account' : 'Candidate account'}</div>
          {s.role === 'candidate' && (
            <button role="menuitem" className="acct-item" onClick={() => { setOpen(false); navigate({ page: 'candidate', sub: 'onboard' }); }}>Profile and consent</button>
          )}
          <button role="menuitem" className="acct-item" data-testid="sign-out"
            onClick={() => { setOpen(false); signOut(); runStore.clear(); navigate({ page: 'login' }); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}
