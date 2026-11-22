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
import { Matches } from '../features/matches/Matches.tsx';
import { Openings } from '../features/openings/Openings.tsx';
import { Outreach } from '../features/outreach/Outreach.tsx';
import { Reading } from '../features/reading/Reading.tsx';
import { Replay } from '../features/replay/Replay.tsx';
import { SourceNote } from '../shell/SourceNote.tsx';
import { setPageSource } from '../shell/ui.ts';

/** /company: choose which company to open (shown when the signed-in company has no id yet). */
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
      <h1 className="h-page">What each company needs next</h1>
      <p className="lede">Companies where a rule fired on dated moves. Open one to see the decision, its clauses and every source.</p>
      <SourceNote source={q.source} error={q.error} />
      {q.loading && !q.data && <p className="lede">Loading companies…</p>}
      <div className="cohort">{q.data?.map((c) => <CohortRow key={c.id} c={c} />)}</div>
      {q.data && !q.data.length && (
        <div className="empty-act">
          <p>No company has a rule decision yet. A scan reads the latest dated job moves and applies rule O1.</p>
          <button className="btn primary" onClick={runScan} disabled={scan === 'starting'} data-testid="run-scan">{scan === 'starting' ? 'Starting the scan…' : 'Run scan'}</button>
          {scan === 'failed' && <p className="bad-text">The scan didn’t start. Check the server on /api and try again.</p>}
        </div>
      )}
    </div>
  );
}

function CohortRow({ c }: { c: CompanySummary }) {
  const to = { page: 'company', id: slug(c.name), tab: 'openings' } as const;
  return (
    <a className="cohort-row surface" href={href(to)} data-testid={`company-${slug(c.name)}`} onClick={(e) => { e.preventDefault(); navigate(to); }}>
      <span className="cohort-name">{c.name}<small>{c.domain}</small></span>
      <span>{plural(c.departures90d, 'departure')} in 90 days</span>
      <span>{c.openings ? <span className="tag live">{plural(c.openings, 'predicted opening')}</span> : null}{c.held ? <span className="tag warn">{c.held} held</span> : null}</span>
      <span className="num">{c.headcount ? `${fmtInt(c.headcount)} staff` : ''}</span>
    </a>
  );
}

const GROUPS: TabGroup[] = ['Predict', 'Act'];

/** /company/:id/:tab: the signed-in company's working tool. Features the user opens, grouped as Predict and Act. */
export function CompanyPage({ route }: { route: Extract<Route, { page: 'company' }> }) {
  const list = useQuery('companies', () => deskApi.companies());
  const id = useMemo(() => list.data?.find((c) => c.id === route.id || slug(c.name) === route.id)?.id ?? route.id, [list.data, route.id]);
  const ready = !!list.data || !!list.error;
  const q = useQuery<CompanyDesk>(ready ? `company:${id}` : null, () => deskApi.company(id));
  const desk = q.data;
  useRunScope(desk?.runId ?? null);
  useEffect(() => { setPageSource(q.source); }, [q.source]);
  const tabs = COMPANY_TABS.filter((t) => BUILT_TABS.has(t.id));
  const current = COMPANY_TABS.find((t) => t.id === route.tab)!;
  const tab: CompanyTab = BUILT_TABS.has(route.tab) ? route.tab : 'openings';
  const counts: Partial<Record<CompanyTab, number>> = desk ? { openings: desk.openings.length, matches: desk.matches.length } : {};
  const go = (t: CompanyTab) => navigate({ page: 'company', id: route.id, tab: t }, true);

  return (
    <div className="co">
      <nav className="co-nav" aria-label={`${desk?.company.name ?? 'Company'} features`}>
        <div className="co-nav-name" data-testid="company-name">{desk?.company.name ?? (q.error ? 'Not found' : ' ')}</div>
        <div className="co-nav-sub">{desk ? [desk.company.domain, desk.company.headcount ? `${fmtInt(desk.company.headcount)} staff` : null].filter(Boolean).join(', ') : ' '}</div>
        {GROUPS.map((g) => {
          const items = tabs.filter((t) => t.group === g);
          if (!items.length) return null;
          return (
            <div className="co-group" key={g}>
              <div className="co-group-label">{g}</div>
              {items.map((t) => (
                <a key={t.id} href={href({ page: 'company', id: route.id, tab: t.id })} aria-current={tab === t.id ? 'page' : undefined}
                  data-testid={`tab-${t.id}`} onClick={(e) => { e.preventDefault(); go(t.id); }} title={t.hint}>
                  <span>{t.label}</span>{counts[t.id] != null && <span className="count" data-num>{counts[t.id]}</span>}
                </a>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="co-main">
        <header className="co-head">
          <h1 className="h-page">{(BUILT_TABS.has(route.tab) ? current : COMPANY_TABS[0]).label}</h1>
          <p className="co-hint">{(BUILT_TABS.has(route.tab) ? current : COMPANY_TABS[0]).hint}</p>
          <SourceNote source={q.source} error={q.error} onRetry={() => invalidate(`company:${id}`)} />
        </header>
        {!desk && !q.error && <div className="ghost-rows" aria-hidden><span /><span /><span /></div>}
        {desk && (
          <section data-testid={`panel-${tab}`}>
            {tab === 'openings' && <Openings desk={desk} />}
            {tab === 'matches' && <Matches desk={desk} />}
            {tab === 'rundesk' && <Reading desk={desk} />}
            {tab === 'file' && <Analysis desk={desk} />}
            {tab === 'rules' && <Chains desk={desk} />}
            {tab === 'outreach' && <Outreach desk={desk} />}
            {tab === 'replay' && <Replay />}
            {tab === 'ledger' && <LedgerTab />}
          </section>
        )}
      </div>
    </div>
  );
}
