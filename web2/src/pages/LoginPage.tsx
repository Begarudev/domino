// "/": the only screen where both roles appear. An app sign-in, not a cover: one line of pitch, the live numbers
// behind it, and a single panel. Choose once; switching later means signing out from the account menu.
import { useMemo, useState } from 'react';
import { deskApi, useQuery } from '../data/query.ts';
import { navigate, slug } from '../data/router.ts';
import { fmtDate, fmtInt, fmtTime } from '../lib/format.ts';
import { signInCandidate, signInCompany } from '../shell/ui.ts';
import type { FunnelStage } from '../../../shared/desk.ts';

type Choice = 'candidate' | 'company';
interface FunnelLite { runId?: string; lockedAt?: string; snapshot?: string; stages?: FunnelStage[] }

export function LoginPage() {
  const [choice, setChoice] = useState<Choice>('company');
  const companies = useQuery('companies', () => deskApi.companies());
  const funnel = useQuery<FunnelLite | null>('funnel', async () => {
    const r = await fetch('/api/openings/funnel').catch(() => null);
    const ok = r && r.ok && (r.headers.get('content-type') ?? '').includes('json');
    return { data: ok ? (await r.json()) as FunnelLite : null, source: 'live', evidence: [] };
  });
  const hero = (companies.data ?? []).find((c) => c.openings)?.id ?? null;
  const scan = useQuery(hero ? `company:${hero}` : null, () => deskApi.company(hero!));

  const stats = useMemo(() => {
    const stages = funnel.data?.stages ?? [];
    const out: { big: string; small: string }[] = [];
    if (stages[0]) out.push({ big: fmtInt(stages[0].count), small: 'job moves read' });
    const conclusive = stages.find((s) => /conclusive/i.test(s.label));
    if (conclusive) out.push({ big: fmtInt(conclusive.count), small: 'conclusive, dated departures' });
    if (companies.data) {
      const decided = companies.data.reduce((n, c) => n + c.openings, 0);
      out.push({ big: fmtInt(decided), small: decided === 1 ? 'predicted opening' : 'predicted openings' });
      out.push({ big: fmtInt(companies.data.length), small: 'companies scanned' });
    }
    return out;
  }, [funnel.data, companies.data]);
  const at = scan.data?.checkedAt ?? null;

  return (
    <div className="signin" data-testid="login">
      <header className="signin-head">
        <h1>Predict what a company needs next, from moves at other companies.</h1>
        <p>Rules decide. Every claim has a dated source. The model is labelled where it’s used: parsing a profile, refining a request, drafting a message.</p>
        {stats.length > 0 && (
          <dl className="signin-stats">
            {stats.map((s) => <div key={s.small}><dt>{s.small}</dt><dd data-num>{s.big}</dd></div>)}
          </dl>
        )}
        {at && <p className="signin-at">Latest scan {fmtDate(at, true)}, {fmtTime(at)} IST</p>}
      </header>
      <section className="signin-panel panel" aria-label="Sign in">
        <h2>Sign in as</h2>
        <button className="role" aria-pressed={choice === 'candidate'} onClick={() => setChoice('candidate')} data-testid="signin-candidate">
          <span className="rad" /><span><b>Candidate</b><p>See companies likely to need you, before they post.</p></span>
        </button>
        <button className="role" aria-pressed={choice === 'company'} onClick={() => setChoice('company')} data-testid="signin-company">
          <span className="rad" /><span><b>Company</b><p>See what you’ll need next, and act on it with proof.</p></span>
        </button>
        {choice === 'company' ? <CompanyPick /> : (
          <button className="btn pri signin-go" data-testid="signin-continue"
            onClick={() => { signInCandidate(); navigate({ page: 'candidate', sub: 'onboard' }); }}>Continue</button>
        )}
        <p className="login-legal">Demo sign-in, no password. To switch sides, sign out from the account menu.</p>
      </section>
    </div>
  );
}

function CompanyPick() {
  const q = useQuery('companies', () => deskApi.companies());
  const [term, setTerm] = useState('');
  const rows = (q.data ?? []).filter((c) => c.name.toLowerCase().includes(term.trim().toLowerCase())).slice(0, 40);
  const go = (name: string) => { signInCompany(slug(name), name); navigate({ page: 'company', id: slug(name), tab: 'recruitment' }); };
  return (
    <div className="login-field">
      <label htmlFor="co-search">Your company</label>
      <input id="co-search" className="field" placeholder="Search 200+ companies" value={term} onChange={(e) => setTerm(e.target.value)} data-testid="company-search" />
      <div className="pick" role="listbox" aria-label="Companies">
        {q.loading && !q.data && <p className="pick-note">Loading companies…</p>}
        {q.error && <p className="pick-note bad-text">Couldn’t load companies: {q.error}</p>}
        {rows.map((c) => (
          <button key={c.id} className="pick-row" role="option" aria-selected={false} data-testid={`signin-${slug(c.name)}`} onClick={() => go(c.name)}>
            <span className="pick-name"><b>{c.name}</b>{c.domain && <small>{c.domain}</small>}</span>
            <span className="pick-meta">
              {c.openings > 0 && <span className="st prov">O1 · {c.openings === 1 ? 'opening' : `${c.openings} openings`}</span>}
              {(c.held ?? 0) > 0 && <span className="st held">Held</span>}
              {c.departures90d > 0 && <span className="num">{fmtInt(c.departures90d)} left in 90 days</span>}
            </span>
          </button>
        ))}
        {q.data && !rows.length && <p className="pick-note">No company matches “{term}”.</p>}
      </div>
    </div>
  );
}
