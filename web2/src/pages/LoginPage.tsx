// "/": the only screen where both roles appear. Choose once; the app then behaves fully as that role.
import { useState } from 'react';
import { deskApi, useQuery } from '../data/query.ts';
import { navigate, slug } from '../data/router.ts';
import { fmtInt } from '../lib/format.ts';
import { signInCandidate, signInCompany } from '../shell/ui.ts';

export function LoginPage() {
  const [step, setStep] = useState<'role' | 'company'>('role');
  return (
    <div className="login" data-testid="login">
      <section className="login-pitch">
        <h1 className="login-h">Predict what a company needs next.</h1>
        <p className="login-p">
          DOMINO follows moves between companies, people leaving, deals, new rules, and works out what each company
          will need next. Then it helps act on it: hire the right people, reach the right buyers. Rules decide, and
          every claim has a dated source.
        </p>
      </section>
      <section className="login-card surface" aria-label="Sign in">
        {step === 'role' ? <RoleStep onCompany={() => setStep('company')} /> : <CompanyStep onBack={() => setStep('role')} />}
        <p className="login-foot">Demo sign-in. No password, and nothing you do here is sent outside the team’s test inbox.</p>
      </section>
    </div>
  );
}

function RoleStep({ onCompany }: { onCompany: () => void }) {
  return (
    <>
      <h2 className="login-card-h">Sign in as</h2>
      <button className="role" data-testid="signin-candidate" onClick={() => { signInCandidate(); navigate({ page: 'candidate', sub: 'onboard' }); }}>
        <span className="role-name">Candidate</span>
        <span className="role-why">See companies likely to need you, before they post</span>
      </button>
      <button className="role" data-testid="signin-company" onClick={onCompany}>
        <span className="role-name">Company</span>
        <span className="role-why">See what you’ll need next, and act on it with proof</span>
      </button>
    </>
  );
}

function CompanyStep({ onBack }: { onBack: () => void }) {
  const q = useQuery('companies', () => deskApi.companies());
  const [term, setTerm] = useState('');
  const rows = (q.data ?? []).filter((c) => c.name.toLowerCase().includes(term.trim().toLowerCase()));
  const go = (id: string, name: string) => { signInCompany(slug(name), name); navigate({ page: 'company', id: slug(name), tab: 'openings' }); };
  return (
    <>
      <h2 className="login-card-h">Which company?</h2>
      <input className="field" placeholder="Search companies" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus data-testid="company-search" aria-label="Search companies" />
      <div className="pick">
        {q.loading && !q.data && <p className="pick-note">Loading companies…</p>}
        {q.error && <p className="pick-note bad">Couldn’t load companies: {q.error}</p>}
        {rows.map((c) => (
          <button key={c.id} className="pick-row" data-testid={`signin-${slug(c.name)}`} onClick={() => go(c.id, c.name)}>
            <span className="pick-name">{c.name}<small>{c.domain ?? ''}</small></span>
            <span className="pick-meta" data-num>{c.headcount ? `${fmtInt(c.headcount)} staff` : ''}</span>
          </button>
        ))}
        {q.data && !rows.length && <p className="pick-note">No company matches “{term}”.</p>}
      </div>
      <button className="btn small ghost" onClick={onBack}>Back</button>
    </>
  );
}
