// Search Desk contract (pivot approved 22 Nov 2026, 14:08 IST). Shapes agreed with ui-v2; docs/CONTRACT.md "Search Desk".
// Evidence stays the shared Evidence type: every response that cites evidence ids also returns those Evidence rows.
import type { Company, Evidence, IsoDate, IsoDateTime, ReplayScore } from './types.ts';

export type RoleFamily = 'inference' | 'ml_platform' | 'mlops' | 'gpu_llm_infra' | 'backend_payments';
export const ROLE_FAMILY_LABELS: Record<RoleFamily, string> = {
  inference: 'Inference / model serving', ml_platform: 'ML platform / ML infrastructure', mlops: 'MLOps',
  gpu_llm_infra: 'GPU / LLM infrastructure', backend_payments: 'Backend / payments',
};

export interface Consent {
  shareHistory: boolean;            // work history from the public profile
  shareSkills: boolean;
  shareSamples: boolean;            // work samples the candidate pasted
  discoverable: boolean;            // companies may see the candidate in Matched candidates and request an intro
  recordedAt?: IsoDateTime;         // set by the server
}

export interface CandidateHistoryItem { company: string; companyId?: string | null; title: string; from: IsoDate | null; to: IsoDate | null }

export interface Candidate {
  id: string;
  status: 'enriching' | 'ready' | 'failed';
  linkedinUrl: string;
  displayName: string;              // first name + last initial ("Asha K.")
  headline: string | null;
  roleFamily: RoleFamily | null;
  skills: string[];
  history: CandidateHistoryItem[];  // only when consent.shareHistory
  samples: string[];                // only when consent.shareSamples
  consent: Consent;
  confirmedAt: IsoDateTime | null;  // candidate confirmed the profile shown back to them
  evidenceIds: string[];            // the person-enrich evidence rows behind the profile
  runId: string;                    // the candidate pipeline run (stream its events at /api/runs/:runId/stream)
  parsedBy: 'llm' | 'rules';
  fixture?: boolean;                // labelled fictional demo candidate
}

export type OpeningReasonKind = 'talent_drain' | 'no_replacement' | 'funding' | 'news' | 'headcount';
export interface OpeningReason { kind: OpeningReasonKind; label: string; date: IsoDate | null; evidenceId: string | null }

export interface Opening {
  id: string;
  companyId: string;
  companyName: string;
  roleFamily: RoleFamily;
  roleTitle: string;                // e.g. "ML Platform Engineer"
  status: 'open' | 'watch' | 'held';
  confidence: number;               // 0..1
  predictedAt: IsoDate;             // the as-of date of the scan
  rule: 'O1';
  reasons: OpeningReason[];
  holdReasons?: string[];           // status 'held': acqui-hire, shared parent, >40% moving, ambiguous id, month-only dates,
                                    // unrecognised titles, possible restructure (headcount down >10% / layoff news)
  watch?: { have: number; need: number; reason?: string }; // status 'watch' (e.g. stale job data: can't verify no replacement)
  evidenceIds: string[];
  runId: string;                    // the openings scan run that produced it
}

export interface Departure {
  id: string;
  companyId: string;                // the company the person left (A)
  role: string;                     // previous title, e.g. "Inference Engineer"
  roleFamily: RoleFamily | null;
  initial: string;                  // "A." — never a full name of a real person
  date: IsoDate | null;             // start of the new role (month precision is flagged)
  precision: 'day' | 'month';
  toCompanyId: string | null;
  toCompanyName: string | null;
  evidenceId: string;
}

export interface FitReason { text: string; status: 'verified' | 'cant_verify'; profileField?: string; evidenceId?: string }
export interface Match { candidateId: string; candidateLabel: string; openingId: string; score: number; fit: FitReason[] }

export interface IntroRequest {
  id: string;
  direction: 'candidate_to_company' | 'company_to_candidate';
  candidateId: string;
  companyId: string;
  companyName: string;
  openingId: string;
  roleTitle: string;
  message: string;                  // the verified intro draft
  status: 'new' | 'awaiting_approval' | 'accepted' | 'declined' | 'delivered';
  runId: string | null;             // intro pipeline run: draft, approval, outbox (send once)
  receivedAt: IsoDateTime;
}

export interface CompanySummary { id: string; name: string; domain: string | null; headcount: number | null; openings: number; departures90d: number }

export interface CompanyView {
  company: Company;
  departures: Departure[];
  openings: Opening[];
  matches: Match[];
  intros: IntroRequest[];
  runId: string | null;             // latest openings scan run
  replay: ReplayScore | null;       // latest replay scan
  evidence: Evidence[];
}

export interface OpeningForCandidate extends Opening { fit: FitReason[]; matchScore: number }
