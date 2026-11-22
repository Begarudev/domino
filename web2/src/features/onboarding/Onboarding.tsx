// FEATURE 1: candidate onboarding (paste LinkedIn URL + optional work samples, consent checklist, live enrich,
// confirm the parsed profile). Replace this placeholder.
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Onboarding() {
  return (
    <div className="page">
      <h1 className="h-page">Find the job before it’s posted</h1>
      <p className="lede">Paste your LinkedIn. DOMINO reads it once, with your consent, and watches for companies that just lost someone like you.</p>
      <Placeholder title="Onboarding">LinkedIn URL, work samples, consent checklist, live enrich, confirm profile.</Placeholder>
    </div>
  );
}
