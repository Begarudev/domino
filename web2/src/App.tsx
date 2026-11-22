import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useEnterOnce } from './lib/motion.ts';
import { navigate, useRoute } from './data/router.ts';
import type { Route } from './data/router.ts';
import { runStore } from './data/store.ts';
import { CandidatePage } from './pages/CandidatePage.tsx';
import { CompaniesPage, CompanyPage } from './pages/CompanyPage.tsx';
import { TracePage } from './features/trace/Trace.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { TopBar } from './shell/TopBar.tsx';
import { LedgerDrawer } from './features/ledger/Ledger.tsx';
import { EvidenceDrawer } from './shell/EvidenceDrawer.tsx';
import { getShell, useShell } from './shell/ui.ts';
import type { Role } from './shell/ui.ts';

let booted = false;

/** Page change: a 200 ms fade and 6 px rise, once per page (tabs inside a page don't refade the whole page). */
function PageFade({ children }: { children: ReactNode }) {
  const ref = useEnterOnce<HTMLDivElement>(false, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 200);
  return <div ref={ref} className="page-fade">{children}</div>;
}

/** Where a route belongs. Each role only ever sees its own side; anything else goes back to sign-in or home. */
function guard(route: Route, role: Role | null): Route | null {
  if (route.page === 'login') return null;
  if (!role) return { page: 'login' };
  if (role === 'candidate' && route.page !== 'candidate') return { page: 'candidate', sub: 'dashboard' };
  if (role === 'company' && route.page === 'candidate') {
    const id = getShell().companyId;
    return id ? { page: 'company', id, tab: 'recruitment' } : { page: 'companies' };
  }
  return null;
}

export function App() {
  const route = useRoute();
  const role = useShell((s) => s.role);
  const redirect = guard(route, role);

  useEffect(() => { if (redirect) navigate(redirect, true); }, [redirect]);

  useEffect(() => {
    if (booted) return; // StrictMode runs effects twice in dev; the run store is a singleton, boot it once
    booted = true;
    const params = new URLSearchParams(location.search);
    void runStore.init(params).then(async () => {
      const v = runStore.get();
      if (v.mode === 'sample') { await runStore.loadSample(); if (params.get('autoplay') === '1') runStore.play(); return; }
      const run = params.get('run');
      if (run && runStore.backend) await runStore.attach(run, { paced: params.get('play') === '1' });
      // Otherwise the rail stays empty until a page scopes it to its own run.
    });
  }, []);

  if (redirect) return null;
  if (route.page === 'login') {
    return (
      <div className="app app-login">
        <TopBar minimal />
        <main className="main" id="main"><LoginPage /></main>
      </div>
    );
  }
  return (
    <div className={`app side-${role ?? 'none'}`}>
      <TopBar />
      <div className="body">
        <main className="main" id="main">
          <PageFade key={route.page === 'candidate' ? `c-${route.sub}` : route.page}>
            {route.page === 'candidate' && <CandidatePage route={route} />}
            {route.page === 'companies' && <CompaniesPage />}
            {route.page === 'company' && <CompanyPage route={route} />}
            {route.page === 'trace' && <TracePage route={route} />}
          </PageFade>
        </main>
      </div>
      <LedgerDrawer />
      <EvidenceDrawer />
    </div>
  );
}
