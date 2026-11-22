import { useEffect } from 'react';
import { navigate, useRoute } from './data/router.ts';
import { runStore } from './data/store.ts';
import { CandidatePage } from './pages/CandidatePage.tsx';
import { CompaniesPage, CompanyPage } from './pages/CompanyPage.tsx';
import { ActivityRail } from './shell/ActivityRail.tsx';
import { TopBar } from './shell/TopBar.tsx';
import { LedgerDrawer } from './features/ledger/Ledger.tsx';
import { EvidenceDrawer } from './shell/EvidenceDrawer.tsx';

let booted = false;

export function App() {
  const route = useRoute();

  useEffect(() => {
    if (booted) return; // StrictMode runs effects twice in dev; the run store is a singleton, boot it once
    booted = true;
    if (location.pathname === '/' || location.pathname === '') navigate({ page: 'candidate', sub: 'dashboard' }, true);
    const params = new URLSearchParams(location.search);
    void runStore.init(params).then(async () => {
      const v = runStore.get();
      if (v.mode === 'sample') { await runStore.loadSample(); if (params.get('autoplay') === '1') runStore.play(); return; }
      if (!runStore.backend) return;
      const run = params.get('run');
      if (run) { await runStore.attach(run, { paced: params.get('play') === '1' }); return; }
      if (v.mode === 'mock') return;
      // No run named: show the most recent run's activity, settled, so the rail is never blank on a working server.
      try {
        const res = await fetch('/api/runs');
        const runs = (await res.json()) as { id: string; createdAt: string }[];
        const latest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest) await runStore.attach(latest.id);
      } catch { /* the rail shows its idle state */ }
    });
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <main className="main" id="main">
          {route.page === 'candidate' && <CandidatePage route={route} />}
          {route.page === 'companies' && <CompaniesPage />}
          {route.page === 'company' && <CompanyPage route={route} />}
        </main>
        <ActivityRail />
      </div>
      <LedgerDrawer />
      <EvidenceDrawer />
    </div>
  );
}
