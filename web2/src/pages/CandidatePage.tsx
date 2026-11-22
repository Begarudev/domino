import { CandidateDashboard } from '../features/dashboard/CandidateDashboard.tsx';
import { Onboarding } from '../features/onboarding/Onboarding.tsx';
import { navigate } from '../data/router.ts';
import type { Route } from '../data/router.ts';
import { useShell } from '../shell/ui.ts';

/** Profile tab = onboarding; Openings tab = the dashboard, once a profile is confirmed. */
export function CandidatePage({ route }: { route: Extract<Route, { page: 'candidate' }> }) {
  const candidateId = useShell((s) => s.candidateId);
  if (route.sub === 'onboard') return <Onboarding />;
  if (!candidateId) {
    return (
      <div className="page">
        <div className="ph"><div><h1>Companies likely to need you</h1><p>Openings appear once you confirm your profile: DOMINO matches rule O1 decisions to your role family.</p></div></div>
        <div className="empty-act cand-wait">
          <p>Your profile isn’t confirmed yet.</p>
          <button className="btn pri" data-testid="go-profile" onClick={() => navigate({ page: 'candidate', sub: 'onboard' })}>Set up your profile</button>
        </div>
      </div>
    );
  }
  return <CandidateDashboard candidateId={candidateId} />;
}
