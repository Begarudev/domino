import { useMemo } from 'react';
import { deskApi, useQuery } from '../data/query.ts';
import { COMPANY_TABS, href, navigate, slug } from '../data/router.ts';
import type { CompanyTab, Route, TabGroup } from '../data/router.ts';
import type { CompanyDesk, CompanySummary } from '../data/desk.ts';
import { fmtInt } from '../lib/format.ts';
import { Analysis } from '../features/analysis/Analysis.tsx';
import { Chains } from '../features/chains/Chains.tsx';
import { Drain } from '../features/drain/Drain.tsx';
import { LedgerTab } from '../features/ledger/Ledger.tsx';
import { Matches } from '../features/matches/Matches.tsx';
import { Needs } from '../features/needs/Needs.tsx';
import { Openings } from '../features/openings/Openings.tsx';
import { Outreach } from '../features/outreach/Outreach.tsx';
import { Reading } from '../features/reading/Reading.tsx';
import { Replay } from '../features/replay/Replay.tsx';
import { SourceNote } from '../shell/SourceNote.tsx';

/** /company: pick a company from the scanned cohort. */
export function CompaniesPage() {
  const q = useQuery('companies', () => deskApi.companies());
  return (
    <div className="page">
      <h1 className="h-page">Companies with a talent drain</h1>
      <p className="lede">Rule O1: two or more people in one role family left within 90 days, and no one was hired or posted to replace them. Open a company to see who left, the opening it predicts, and the full DOMINO analysis.</p>
      <SourceNote source={q.source} error={q.error} />
      {q.loading && !q.data && <p className="lede">Loading the cohort…</p>}
      <div className="cohort">
        {q.data?.map((c) => <CohortRow key={c.id} c={c} />)}
      </div>
      {q.data && !q.data.length && <p className="lede">No company has two or more departures in one role family yet. Run a scan to read the latest job moves.</p>}
    </div>
  );
}

function CohortRow({ c }: { c: CompanySummary }) {
  const to = { page: 'company', id: slug(c.name), tab: 'openings' } as const;
  return (
    <a className="cohort-row surface" href={href(to)} data-testid={`company-${slug(c.name)}`} onClick={(e) => { e.preventDefault(); navigate(to); }}>
      <span className="cohort-name">{c.name}<small>{c.domain}</small></span>
      <span><b data-num>{fmtInt(c.departures90d)}</b> left in 90 days</span>
      <span>{c.openings ? <span className="tag live">{c.openings} predicted {c.openings === 1 ? 'opening' : 'openings'}</span> : null}{c.held ? <span className="tag warn">{c.held} held</span> : null}</span>
      <span className="num">{c.headcount ? `${fmtInt(c.headcount)} staff` : ''}</span>
    </a>
  );
}

const GROUPS: TabGroup[] = ['Hiring', 'DOMINO workflows', 'Proof'];

/** /company/:id/:tab: features the user opens, grouped. Not a pipeline. */
export function CompanyPage({ route }: { route: Extract<Route, { page: 'company' }> }) {
  const list = useQuery('companies', () => deskApi.companies());
  // Routes accept the company id or its slug ("abacus-ai").
  const id = useMemo(() => list.data?.find((c) => c.id === route.id || slug(c.name) === route.id)?.id ?? route.id, [list.data, route.id]);
  const ready = !!list.data || !!list.error || route.id.startsWith('co_');
  const q = useQuery<CompanyDesk>(ready ? `company:${id}` : null, () => deskApi.company(id));
  const desk = q.data;
  const counts: Partial<Record<CompanyTab, number>> = desk ? {
    openings: desk.openings.length, drain: desk.departures.length, matches: desk.matches.length,
  } : {};
  const go = (tab: CompanyTab) => navigate({ page: 'company', id: route.id, tab }, true);
  const current = COMPANY_TABS.find((t) => t.id === route.tab)!;

  return (
    <div className="co">
      <nav className="co-nav" aria-label="Company features">
        <a href={href({ page: 'companies' })} onClick={(e) => { e.preventDefault(); navigate({ page: 'companies' }); }} className="crumb">All companies</a>
        <div className="co-nav-name" data-testid="company-name">{desk?.company.name ?? (q.error ? 'Not found' : '…')}</div>
        {desk && <div className="co-nav-sub">{[desk.company.domain, desk.company.headcount ? `${fmtInt(desk.company.headcount)} staff` : null].filter(Boolean).join(', ')}</div>}
        {GROUPS.map((g) => (
          <div className="co-group" key={g}>
            <div className="co-group-label">{g}</div>
            {COMPANY_TABS.filter((t) => t.group === g).map((t) => (
              <a key={t.id} href={href({ page: 'company', id: route.id, tab: t.id })} aria-current={route.tab === t.id ? 'page' : undefined}
                data-testid={`tab-${t.id}`} onClick={(e) => { e.preventDefault(); go(t.id); }} title={t.hint}>
                <span>{t.label}</span>{counts[t.id] != null && <span className="count" data-num>{counts[t.id]}</span>}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="co-main">
        <header className="co-head">
          <h1 className="h-page">{current.label}</h1>
          <p className="co-hint">{current.hint}{desk ? `, ${desk.company.name}` : ''}</p>
        </header>
        <SourceNote source={q.source} error={q.error} />
        {desk && (
          <section data-testid={`panel-${route.tab}`}>
            {route.tab === 'openings' && <Openings desk={desk} />}
            {route.tab === 'drain' && <Drain desk={desk} />}
            {route.tab === 'matches' && <Matches desk={desk} />}
            {route.tab === 'reading' && <Reading desk={desk} />}
            {route.tab === 'analysis' && <Analysis desk={desk} />}
            {route.tab === 'chains' && <Chains desk={desk} />}
            {route.tab === 'needs' && <Needs desk={desk} />}
            {route.tab === 'outreach' && <Outreach desk={desk} />}
            {route.tab === 'replay' && <Replay />}
            {route.tab === 'ledger' && <LedgerTab />}
          </section>
        )}
      </div>
    </div>
  );
}
