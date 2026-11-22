// Candidate and intro pipelines (Search Desk). OWNER: domino-desk-api. Stubs keep the pipelines runnable end to end;
// replace each runner. Contract: shared/desk.ts + docs/CONTRACT.md "Search Desk".
import type { Approval, Draft, Evidence } from '../../shared/types.ts';
import type { Candidate, Match } from '../../shared/desk.ts';
import type { Runner } from './steps.ts';

export type ParsedProfile = Pick<Candidate, 'displayName' | 'headline' | 'roleFamily' | 'skills' | 'history' | 'parsedBy'>;
export interface CandidateOutputs {
  fetch_profile: { found: boolean; evidence: Evidence[] };
  parse_profile: ParsedProfile;
  match_openings: { matches: Match[] };
  draft_intro: { introId: string; draft: Draft | null };
  intro_gate: Approval[];
}

export const candidateSteps: { [K in keyof CandidateOutputs]: Runner<K> } = {
  fetch_profile: () => ({ output: { found: false, evidence: [] }, summary: 'Not built yet' }),
  parse_profile: () => ({ output: { displayName: '', headline: null, roleFamily: null, skills: [], history: [], parsedBy: 'rules' },
    summary: 'Not built yet' }),
  match_openings: () => ({ output: { matches: [] }, summary: 'Not built yet' }),
  draft_intro: () => ({ output: { introId: '', draft: null }, summary: 'Not built yet' }),
  intro_gate: () => ({ output: [], summary: 'Not built yet' }),
};
