// "/": the only screen where both roles appear (design mock screen 1). Choose once; the app then behaves fully as
// that role. Switching later means signing out from the account menu.
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
  const scan = useQuery('companies:hero', () => deskApi.company((companies.data ?? []).find((c) => c.openings)?.id ?? 'abacus-ai'));

  const proof = useMemo(() => {
    const stages = funnel.data?.stages ?? [];
    const first = stages[0];
    const conclusive = stages.find((s) => /conclusive/i.test(s.label));
    const decided = (companies.data ?? []).reduce((n, c) => n + c.openings, 0);
    const out: { big: string; small: string; mono?: boolean }[] = [];
    if (first) out.push({ big: fmtInt(first.count), small: first.label });
    else if (companies.data?.length) out.push({ big: fmtInt(companies.data.length), small: 'companies in the last scan' });
    if (conclusive) out.push({ big: fmtInt(conclusive.count), small: conclusive.label });
    if (companies.data) out.push({ big: fmtInt(decided), small: decided === 1 ? 'predicted opening today' : 'predicted openings today' });
    const runId = funnel.data?.runId ?? scan.data?.runId;
    const at = scan.data?.checkedAt ?? null;
    if (runId) out.push({ big: at ? fmtTime(at) : 'Latest', small: at ? `latest scan, ${fmtDate(at, true)} IST` : 'latest scan run' });
    return out;
  }, [funnel.data, companies.data, scan.data]);

  return (
    <div className="login" data-testid="login">
      <section className="login-l">
        <p className="muted" style={{ fontSize: 15, margin: 0 }}>One company’s move is another company’s need.</p>
        <h1 className="login-h">DOMINO predicts what a company needs next from the domino effects between companies, and helps it act: hire the right people and reach the right buyers, with proof.</h1>
        <p className="login-p">Rules decide. Every claim has a dated source. The language model is labelled where it’s used: parsing a profile, refining a request, drafting a message.</p>
        {proof.length > 0 && (
          <div className="login-proof">
            {proof.map((p) => <div key={p.small}><b className={p.mono ? 'mono' : undefined} style={p.mono ? { fontSize: 15, lineHeight: '30px' } : undefined}>{p.big}</b><span>{p.small}</span></div>)}
          </div>
        )}
      </section>
      <section className="login-r" aria-label="Sign in">
        <h2>Sign in as</h2>
        <button className="role" aria-pressed={choice === 'candidate'} onClick={() => setChoice('candidate')} data-testid="signin-candidate">
          <span className="rad" /><span><b>Candidate</b><p>See companies likely to need you, before they post.</p></span>
        </button>
        <button className="role" aria-pressed={choice === 'company'} onClick={() => setChoice('company')} data-testid="signin-company">
          <span className="rad" /><span><b>Company</b><p>See what you’ll need next, and act on it with proof.</p></span>
        </button>
        {choice === 'company' ? <CompanyPick /> : (
          <div className="login-actions">
            <button className="btn pri" style={{ width: '100%', height: 38 }} data-testid="signin-continue"
              onClick={() => { signInCandidate(); navigate({ page: 'candidate', sub: 'onboard' }); }}>Continue</button>
          </div>
        )}
        <p className="login-legal">Demo sign-in, no password. To switch sides later, sign out from the account menu.</p>
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
      <input id="co-search" className="field" placeholder="Search companies" value={term} onChange={(e) => setTerm(e.target.value)} data-testid="company-search" />
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
