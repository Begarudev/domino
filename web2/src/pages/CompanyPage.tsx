import { useEffect, useMemo, useState } from 'react';
import { deskApi, invalidate, useQuery } from '../data/query.ts';
import { BUILT_TABS, COMPANY_TABS, href, navigate, slug } from '../data/router.ts';
import type { CompanyTab, Route, TabGroup } from '../data/router.ts';
import type { CompanyDesk, CompanySummary } from '../data/desk.ts';
import { runStore, useRunScope } from '../data/store.ts';
import { fmtInt, plural } from '../lib/format.ts';
import { Analysis } from '../features/analysis/Analysis.tsx';
import { Chains } from '../features/chains/Chains.tsx';
import { LedgerTab } from '../features/ledger/Ledger.tsx';
import { Needs } from '../features/needs/Needs.tsx';
import { Openings } from '../features/openings/Openings.tsx';
import { Buyers } from '../features/buyers/Buyers.tsx';
import { Outreach } from '../features/outreach/Outreach.tsx';
import { Replay } from '../features/replay/Replay.tsx';
import { Reading } from '../features/reading/Reading.tsx';
import { SourceNote } from '../shell/SourceNote.tsx';
import { setPageSource } from '../shell/ui.ts';

/** /company: choose which company to open (shown when the signed-in company has no id). */
export function CompaniesPage() {
  const q = useQuery('companies', () => deskApi.companies());
  const [scan, setScan] = useState<'idle' | 'starting' | 'failed'>('idle');
  useEffect(() => { setPageSource(q.source); }, [q.source]);
  const runScan = async () => {
    setScan('starting');
    const r = await deskApi.scanOpenings();
    if (!r) { setScan('failed'); return; }
    await runStore.attach(r.runId);
    setScan('idle');
  };
  return (
    <div className="page">
      <div className="ph"><div><h1>What each company needs next</h1><p>Companies where a rule fired on dated moves. Open one to see the decision, its clauses and every source.</p></div></div>
      <SourceNote source={q.source} error={q.error} />
      {q.loading && !q.data && <p className="loading-line" role="status">Loading companies from the latest scan…</p>}
      <div className="panel">{q.data?.slice(0, 60).map((c) => <CohortRow key={c.id} c={c} />)}</div>
      {q.data && !q.data.length && (
        <div className="empty-act">
          <p>No company has a rule decision yet. A scan reads the latest dated job moves and applies rule O1.</p>
          <button className="btn pri" onClick={runScan} disabled={scan === 'starting'} data-testid="run-scan">{scan === 'starting' ? 'Starting the scan…' : 'Run scan'}</button>
          {scan === 'failed' && <p className="bad-text">The scan didn’t start. Check the server on /api and try again.</p>}
        </div>
      )}
    </div>
  );
}

function CohortRow({ c }: { c: CompanySummary }) {
  const to = { page: 'company', id: slug(c.name), tab: 'recruitment' } as const;
  return (
    <a className="cohort-row" href={href(to)} data-testid={`company-${slug(c.name)}`} onClick={(e) => { e.preventDefault(); navigate(to); }}>
      <span className="cohort-name"><b>{c.name}</b>{c.domain && <small>{c.domain}</small>}</span>
      <span className="num">{plural(c.departures90d, 'departure')} in 90 days</span>
      <span>{c.openings ? <span className="st prov">O1 · {plural(c.openings, 'opening')}</span> : null}{c.held ? <span className="st held">Held</span> : null}</span>
      <span className="num faint">{c.headcount ? `${fmtInt(c.headcount)} staff` : ''}</span>
    </a>
  );
}

const GROUPS: TabGroup[] = ['Act', 'Read', 'Check'];
const OWN_HEADER = new Set<CompanyTab>(['file', 'reading']);

/** /company/:id/:tab: the signed-in company's working tool (design mock screens 4–11). */
export function CompanyPage({ route }: { route: Extract<Route, { page: 'company' }> }) {
  const list = useQuery('companies', () => deskApi.companies());
  const id = useMemo(() => list.data?.find((c) => c.id === route.id || slug(c.name) === route.id)?.id ?? route.id, [list.data, route.id]);
  const ready = !!list.data || !!list.error;
  const q = useQuery<CompanyDesk>(ready ? `company:${id}` : null, () => deskApi.company(id));
  const desk = q.data;
  useRunScope(desk?.runId ?? null);
  useEffect(() => { setPageSource(q.source); }, [q.source]);
  const tabs = COMPANY_TABS.filter((t) => BUILT_TABS.has(t.id));
  const tab: CompanyTab = BUILT_TABS.has(route.tab) ? route.tab : 'recruitment';
  const current = COMPANY_TABS.find((t) => t.id === tab)!;
  const counts: Partial<Record<CompanyTab, number>> = desk ? { recruitment: desk.openings.length } : {};
  const go = (t: CompanyTab) => navigate({ page: 'company', id: route.id, tab: t }, true);

  return (
    <div className="co">
      <nav className="side" aria-label="Company features">
        {GROUPS.map((g) => {
          const items = tabs.filter((t) => t.group === g);
          if (!items.length) return null;
          return (
            <div className="side-grp" key={g}>
              <div className="grp">{g}</div>
              {items.map((t) => (
                <a key={t.id} href={href({ page: 'company', id: route.id, tab: t.id })} aria-current={tab === t.id ? 'page' : undefined}
                  data-testid={`tab-${t.id}`} onClick={(e) => { e.preventDefault(); go(t.id); }}>
                  <span>{t.label}</span>{counts[t.id] != null && <span className="c" data-num>{counts[t.id]}</span>}
                </a>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="co-main">
        {/* Tabs with their own header (file, reading) skip the shell title once their data is in. */}
        {!(desk && OWN_HEADER.has(tab)) && (
          <div className="ph">
            <div>
              <h1 data-testid="company-title">{current.label}</h1>
              <p>{current.hint}</p>
              <SourceNote source={q.source} error={q.error} onRetry={() => invalidate(`company:${id}`)} />
            </div>
          </div>
        )}
        {!desk && !q.error && <p className="loading-line" role="status">Loading {current.label.toLowerCase()} from the latest scan…</p>}
        {desk && (
          <section data-testid={`panel-${tab}`}>
            {tab === 'recruitment' && <Openings desk={desk} />}
            {tab === 'buyers' && <Buyers desk={desk} />}
            {tab === 'outreach' && <Outreach desk={desk} />}
            {tab === 'reading' && <Reading desk={desk} />}
            {tab === 'file' && <Analysis desk={desk} />}
            {tab === 'chains' && <Chains desk={desk} />}
            {tab === 'verifier' && <Needs desk={desk} />}
            {tab === 'replay' && <Replay />}
            {tab === 'ledger' && <LedgerTab />}
          </section>
        )}
      </div>
    </div>
  );
}
