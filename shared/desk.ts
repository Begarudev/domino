// Search Desk contract (pivot approved 22 Nov 2026, 14:08 IST). Shapes agreed with ui-v2; docs/CONTRACT.md "Search Desk".
// Evidence stays the shared Evidence type: every response that cites evidence ids also returns those Evidence rows.
import type {
  Approval, Company, DataMode, Decider, Draft, Evidence, GraphEdge, IsoDate, IsoDateTime, Mechanism, OutboxAction, ReplayScore, TriggerKind,
} from './types.ts';

export type RoleFamily = 'inference' | 'ml_platform' | 'mlops' | 'gpu_llm_infra' | 'backend_payments';
/** Onboarding input limits, enforced by the server's schema and mirrored as maxLength on the form. */
export const LINKEDIN_URL_MAX = 300;
export const SAMPLE_MAX_CHARS = 2000;

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

// 'Edited by candidate' once the candidate changed the field at confirm; otherwise who parsed it.
export type FieldProvenance = 'Edited by candidate' | 'Parsed by GPT-6 Luna' | 'Parsed by rules' | string;

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
  fieldSource?: string;             // "Filled by GPT-6 Luna · confirm each field" (llm) or "Read by rules from your profile · confirm each field"
  provenance?: { roleFamily: FieldProvenance; skills: FieldProvenance }; // who set each editable field
  fixture?: boolean;                // labelled fictional demo candidate
}

// A rule decision is shown as its clauses, never as a bare probability (anti-wrapper rule 4).
export interface RuleClause {
  id: string;                       // e.g. 'o1.departures', 'o1.no_replacement.jobs', 'o1.window', 'guard.acquihire'
  text: string;                     // "2 conclusive ML-platform departures (Oct, Oct)"
  state: 'met' | 'open' | 'failed' | 'cant_verify';
  detail?: string;                  // the date math / search scope: "job search 1 Oct–22 Nov, 0 records, checked 22 Nov"
  evidenceIds: string[];
}

// Funnel with drill-down: every count opens its rows (role + initial + month for people).
export interface FunnelStage { id: string; label: string; count: number; rows?: { label: string; detail?: string; evidenceId?: string }[] }
export interface OpeningsFunnel { runId: string; rule: 'O1'; lockedAt: string; snapshot: string; stages: FunnelStage[]; served?: ServedFrom }

// How a run's Crustdata reads were served: live calls vs the recorded cache, and when the data was actually read.
// e.g. "Live Crustdata read 22 Nov, 14:08–14:17 IST · replayed from the recorded cache (0 credits)"
export interface ServedFrom {
  liveCalls: number; cacheHits: number; credits: number;
  readFrom: string | null; readTo: string | null;   // ISO times of the underlying live reads
  label: string;
}

// Rules registry: id, thresholds, lock time and today's live fire counts.
export interface RuleCard {
  id: 'O1' | 'R1' | 'CONTAGION' | 'DISPLACEMENT' | 'DIRECT' | string;
  name: string; statement: string; thresholds: string[]; guards: string[];
  lockedAt: string;                 // "22 Nov 2026 14:08 IST (after live counts, before replay outcomes)"
  counts: { label: string; value: number; sourceRunId?: string | null }[]; // e.g. fired 0 · watchlist 2 · held 1; a count's own run when it differs from the card's
  sourceRunId: string | null;
}

// "Why this target?": the exact eligibility (O1 clauses) and the ranking rules that placed an opening. No score is used.
export interface RankPlacement { position: number; of: number; rule: string; because: string[] }
export interface WhyThisTarget {
  rule: 'O1';
  statement: string;                // the pre-registered O1 rule text
  verdict: string;                  // "Open: every O1 clause met" | "Open, provisional: ..." | "Watch: ..." | "Held: ..."
  eligibility: RuleClause[];        // the opening's clauses (met / open / failed / cant_verify), with sources
  ranking: RankPlacement;           // place among all openings in the scan
  companyRanking: RankPlacement;    // the company's place in GET /api/companies
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
  confidence?: number;              // internal only; NOT shown (anti-wrapper rule 4). The UI shows `clauses`.
  clauses?: RuleClause[];           // set by the engine for every opening; O1 clauses with state + sources, e.g. ✓ 2 conclusive departures · ⏳ window open
  predictedAt: IsoDate;             // the as-of date of the scan
  rule: 'O1';
  reasons: OpeningReason[];
  holdReasons?: string[];           // status 'held': acqui-hire, shared parent, >40% moving, ambiguous id, month-only dates,
                                    // unrecognised titles, possible restructure (headcount down >10% / layoff news)
  watch?: { have: number; need: number; reason?: string }; // status 'watch' (e.g. stale job data: can't verify no replacement)
  provisional?: boolean;            // open, but the 30-day no-replacement leg is not settled yet (month-level dates)
  windowClosesBy?: IsoDate | null;  // provisional: the date by which the replacement window closes ("closes by 30 Nov")
  why?: WhyThisTarget;              // CompanyView only: the O1 eligibility clauses and the ranking rule that placed it
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
export interface Match { candidateId: string; candidateLabel: string; openingId: string; score?: number; fit: FitReason[] } // score internal, not shown

export interface IntroRequest {
  id: string;
  direction: 'candidate_to_company' | 'company_to_candidate';
  candidateId: string;
  companyId: string;
  companyName: string;
  openingId: string;
  roleTitle: string;
  message: string;                  // the verified intro draft
  status: 'new' | 'awaiting_approval' | 'accepted' | 'declined' | 'delivered' | 'not_drafted';
  blockedReason?: string | null;    // status 'not_drafted': fewer than 2 verified, dated, cited facts, no opening fact, or no named role
  runId: string | null;             // intro pipeline run: draft, approval, outbox (send once)
  approvalId?: string | null;       // POST /api/approvals/:id with this id to approve or reject the send
  evidenceIds?: string[];           // rows the message cites
  citations?: { marker: number; evidenceId: string }[];  // which row each footnote [n] in `message` points to
  unverifiable?: { claim: string; reason: string }[];  // claims the verifier couldn't tie to a dated source ("I can't verify")
  generatorLabel?: string | null;   // e.g. "Drafted by GPT-6 Luna from 4 verified claims" or the template label
  subject?: string | null;
  receipt?: { idempotencyKey: string; receivedAt: IsoDateTime } | null; // from the test-inbox receiver (inbox_received); set once delivered
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

export interface OpeningForCandidate extends Opening { fit: FitReason[]; matchScore?: number } // matchScore internal, not shown

// ---------- company dossier (full company analysis; GET /api/companies/:id/dossier) ----------
// A per-company view of the latest analysis run (outbound pipeline: triggers, entities, cascade rules, targets,
// drafts, approvals, outbox). People who moved appear only as role + initial + date.

// 'check' = a replacement search and its record count; 'news' = a dated article.
export interface DossierEvent { id: string; date: IsoDate; kind: TriggerKind | 'check' | 'news'; summary: string; evidenceIds: string[] }
export interface TalentFlow {
  direction: 'in' | 'out';          // in = joined this company, out = left it
  role: string; initial: string | null; date: IsoDate; precision: 'day' | 'month';
  otherCompanyId: string | null; otherCompanyName: string | null; evidenceIds: string[];
}
export interface DossierChain { edge: GraphEdge; fromName: string; toName: string; side: 'cause' | 'effect' }
export interface PredictedNeed {
  need: string; mechanisms: Mechanism[]; confidence: number; netNew: boolean; whyNow: string; whyNowDate: IsoDate | null;
  status: 'target' | 'held' | 'watch'; holdReasons: string[]; watchReason: string | null; rank: number; evidenceIds: string[];
}
export interface DossierOutreach {
  decider: Decider | null; draft: Draft; approvals: Approval[]; outbox: OutboxAction[];
  verifier: { verified: boolean; removed: string[]; cantVerify: { claim: string; reason: string }[] };
}
// One row per rule for this company: met / not met / held / open (provisional) / not evaluated, with its clauses.
export interface DossierRule {
  id: 'O1' | 'R1' | 'CONTAGION' | 'DISPLACEMENT';
  name: string;
  state: 'met' | 'not_met' | 'held' | 'open' | 'not_evaluated';
  summary: string;
  clauses: RuleClause[];
}

export interface CompanyDossier {
  runId: string; asOf: IsoDate | null; dataMode: DataMode; company: Company;
  source: 'analysis_run' | 'openings_scan';  // which run the file was built from (labelled on screen)
  rules: DossierRule[];
  whyTarget: WhyThisTarget | null;           // eligibility clauses + the ranking rule that placed this company (its top O1 opening)
  headcountSeries: { date: IsoDate; count: number }[];  // Crustdata enrich timeseries up to the scan's as-of date; [] if not read
  timeline: DossierEvent[];         // news/posts, funding, headcount jumps, hires, departures; newest first
  jobPosts: DossierEvent[];
  talentFlows: TalentFlow[];
  chains: DossierChain[];           // cross-company edges where this company is the cause or the effect
  predictedNeeds: PredictedNeed[];
  openings: Opening[];              // Search Desk openings for this company (latest openings scan), if any
  outreach: DossierOutreach[];
  evidence: Evidence[];
}

// GET /api/candidates/:id/intros/preview?openingId= : exactly what an intro would share, before the candidate consents.
export interface IntroPreviewField { field: string; label: string; value: string; evidenceId?: string }
export interface IntroPreview {
  candidateId: string;
  openingId: string;
  companyName: string;
  roleTitle: string;
  shared: IntroPreviewField[];      // fields the intro message will contain, given the current consent
  withheld: { field: string; label: string; reason: string }[]; // never or not shared, and why
}
