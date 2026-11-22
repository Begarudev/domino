import { useMemo } from 'react';
import { deskApi, useQuery } from '../data/query.ts';
import { COMPANY_TABS, href, navigate, slug } from '../data/router.ts';
import type { Route } from '../data/router.ts';
import type { CompanyDesk, CompanySummary } from '../data/desk.ts';
import { fmtInt } from '../lib/format.ts';
import { Analysis } from '../features/analysis/Analysis.tsx';
import { Drain } from '../features/drain/Drain.tsx';
import { LedgerTab } from '../features/ledger/Ledger.tsx';
import { Matches } from '../features/matches/Matches.tsx';
import { Openings } from '../features/openings/Openings.tsx';
import { Outreach } from '../features/outreach/Outreach.tsx';
import { Replay } from '../features/replay/Replay.tsx';
import { SourceNote } from '../shell/SourceNote.tsx';

/** /company: pick a company from the scanned cohort. */
export function CompaniesPage() {
  const q = useQuery('companies', () => deskApi.companies());
  return (
    <div className="page">
      <h1 className="h-page">Companies with a talent drain</h1>
      <p className="lede">Companies where two or more people in one role family left within 90 days. Open one to see who left, what opening that predicts, and who on DOMINO fits.</p>
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
  const to = { page: 'company', id: c.id, tab: 'openings' } as const;
  return (
    <a className="cohort-row surface" href={href(to)} data-testid={`company-${slug(c.name)}`} onClick={(e) => { e.preventDefault(); navigate(to); }}>
      <span className="cohort-name">{c.name}<small>{c.domain}</small></span>
      <span><b data-num>{fmtInt(c.departures90d)}</b> left in 90 days</span>
      <span>{c.openings ? <span className="tag live">{c.openings} predicted {c.openings === 1 ? 'opening' : 'openings'}</span> : null}{c.held ? <span className="tag warn">{c.held} held</span> : null}</span>
      <span className="num">{c.headcount ? `${fmtInt(c.headcount)} staff` : ''}</span>
    </a>
  );
}

/** /company/:id/:tab: features, not a pipeline. Each tab is one feature the user opens. */
export function CompanyPage({ route }: { route: Extract<Route, { page: 'company' }> }) {
  const list = useQuery('companies', () => deskApi.companies());
  // Routes accept the company id or its slug ("abacus-ai").
  const id = useMemo(() => list.data?.find((c) => c.id === route.id || slug(c.name) === route.id)?.id ?? route.id, [list.data, route.id]);
  const q = useQuery<CompanyDesk>(list.data || route.id.startsWith('co_') ? `company:${id}` : null, () => deskApi.company(id));
  const desk = q.data;
  const counts: Partial<Record<string, number>> = desk ? {
    openings: desk.openings.length, drain: desk.departures.length, matches: desk.matches.length,
  } : {};

  return (
    <div className="page">
      <div className="co-head">
        <a href={href({ page: 'companies' })} onClick={(e) => { e.preventDefault(); navigate({ page: 'companies' }); }} className="crumb">All companies</a>
        <h1 className="h-page" data-testid="company-name">{desk?.company.name ?? (q.error ? 'Company not found' : 'Loading…')}</h1>
        {desk && <p className="co-sub">{[desk.company.domain, desk.company.headcount ? `${fmtInt(desk.company.headcount)} staff` : null, desk.company.hq].filter(Boolean).join(', ')}</p>}
      </div>
      <SourceNote source={q.source} error={q.error} />
      <nav className="tabs" aria-label="Company features">
        {COMPANY_TABS.map((t) => {
          const to = { page: 'company', id: route.id, tab: t.id } as const;
          return (
            <a key={t.id} href={href(to)} aria-current={route.tab === t.id ? 'page' : undefined} data-testid={`tab-${t.id}`}
              onClick={(e) => { e.preventDefault(); navigate(to, true); }}>
              {t.label}{counts[t.id] != null && <span className="count">{counts[t.id]}</span>}
            </a>
          );
        })}
      </nav>
      {desk && (
        <section data-testid={`panel-${route.tab}`}>
          {route.tab === 'openings' && <Openings desk={desk} />}
          {route.tab === 'drain' && <Drain desk={desk} />}
          {route.tab === 'matches' && <Matches desk={desk} />}
          {route.tab === 'analysis' && <Analysis desk={desk} />}
          {route.tab === 'outreach' && <Outreach desk={desk} />}
          {route.tab === 'ledger' && <LedgerTab />}
          {route.tab === 'replay' && <Replay />}
        </section>
      )}
    </div>
  );
}
