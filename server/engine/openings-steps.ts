// Openings pipeline (Search Desk, rule O1). OWNER: domino-livedata. Stubs below keep the pipeline runnable end to end;
// replace each runner. Contract: shared/desk.ts + docs/CONTRACT.md "Search Desk".
import type { Company, Evidence, IsoDate, ReplayScore } from '../../shared/types.ts';
import type { Departure, Opening, RoleFamily } from '../../shared/desk.ts';
import type { Runner } from './steps.ts';

export interface SearchScope {
  roleFamilies: RoleFamily[];
  asOf: IsoDate;
  runKind: 'live' | 'replay';
  horizonEnd: IsoDate | null;
  cohort: string;                   // e.g. "AI/ML companies, 20-5,000 staff"
  assumptions: string[];
}
export interface Replacement { companyId: string; roleFamily: RoleFamily; kind: 'job_post' | 'hire'; date: IsoDate; evidenceId: string }
export interface OpeningsOutputs {
  scope_search: SearchScope;
  pull_departures: { departures: Departure[]; evidence: Evidence[] };
  resolve_departures: { companies: Company[]; departures: Departure[]; evidence: Evidence[] };
  check_replacements: { replacements: Replacement[]; staleCompanyIds: string[]; evidence: Evidence[] };
  detect_openings: { openings: Opening[] };
  score_openings: ReplayScore;
}

const today = () => new Date().toISOString().slice(0, 10);
export const openingsSteps: { [K in keyof OpeningsOutputs]: Runner<K> } = {
  scope_search: () => ({
    output: { roleFamilies: ['inference', 'ml_platform', 'mlops', 'gpu_llm_infra'], asOf: today(), runKind: 'live',
      horizonEnd: null, cohort: 'AI/ML companies, 20-5,000 staff', assumptions: [] },
    summary: 'Inference, ML platform, MLOps and GPU/LLM infrastructure roles',
  }),
  pull_departures: () => ({ output: { departures: [], evidence: [] }, summary: 'Not built yet' }),
  resolve_departures: () => ({ output: { companies: [], departures: [], evidence: [] }, summary: 'Not built yet' }),
  check_replacements: () => ({ output: { replacements: [], staleCompanyIds: [], evidence: [] }, summary: 'Not built yet' }),
  detect_openings: () => ({ output: { openings: [] }, summary: 'Not built yet' }),
  score_openings: () => { throw new Error('Openings replay is not built yet'); },
};
