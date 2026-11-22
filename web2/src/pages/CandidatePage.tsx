import { CandidateDashboard } from '../features/dashboard/CandidateDashboard.tsx';
import { Onboarding } from '../features/onboarding/Onboarding.tsx';
import type { Route } from '../data/router.ts';
import { useShell } from '../shell/ui.ts';

/** /candidate: onboarding until a candidate exists on this device, then the dashboard. /candidate/onboard always onboards. */
export function CandidatePage({ route }: { route: Extract<Route, { page: 'candidate' }> }) {
  const candidateId = useShell((s) => s.candidateId);
  if (route.sub === 'onboard' || !candidateId) return <Onboarding />;
  return <CandidateDashboard candidateId={candidateId} />;
}
