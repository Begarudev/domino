// FEATURE 2: candidate dashboard ("Companies likely hiring for you" with dated reason chips + confidence,
// "Companies reaching out" inbox, "Request intro" with consent). Replace this placeholder.
import { Placeholder } from '../../shell/Placeholder.tsx';

export function CandidateDashboard({ candidateId }: { candidateId: string }) {
  return (
    <div className="page" data-candidate={candidateId}>
      <h1 className="h-page">Companies likely hiring for you</h1>
      <Placeholder title="Candidate dashboard">Predicted openings with dated reason chips, the inbox, and Request intro.</Placeholder>
    </div>
  );
}
