// DOMINO shared contract: every type the engine, server and web UI exchange.
// Server code runs on Node 24 with native type stripping: use only erasable TS
// (no enums, no namespaces, no parameter properties) and import with explicit `.ts`.

export type DataMode = 'live' | 'cache' | 'fixture';
export type IsoDate = string;      // 'YYYY-MM-DD' (date a fact was true / happened)
export type IsoDateTime = string;  // full ISO timestamp with zone

// ---------- request / intent ----------

export interface RunLimits {
  maxCredits: number;     // Crustdata credits ceiling for the run
  maxModelUsd: number;    // LLM spend ceiling (USD)
  maxSeconds: number;     // wall-clock ceiling
}

export interface ChaosConfig {
  // Deliberately injected faults so the demo can show recovery. Always labelled "injected" in events.
  timeoutOnce?: string[];   // endpoint names whose FIRST attempt times out
  nonsenseOnce?: string[];  // endpoint names whose FIRST attempt returns schema-invalid junk
}

export interface Intent {
  offering: string | null;          // what the seller sells, e.g. "managed GPU inference"
  buyerProfile: string;             // e.g. "AI companies"
  geography: string | null;         // e.g. "India" or null = anywhere
  windowDays: number;               // trigger window, default 30
  asOf: IsoDate;                    // "today" for the run
  deciderTitles: string[];          // e.g. ["CTO","VP Engineering","Head of ML Platform"]
  signalKeywords: string[];         // e.g. ["inference","ML platform","GPU","LLM serving"]
  maxTargets: number;               // default 5
  parsedBy: 'llm' | 'rules';
  runKind: 'live' | 'replay';       // replay = freeze the world at asOf, predict, then score against what happened after
  horizonEnd: IsoDate | null;       // replay only: outcomes are checked in (asOf, horizonEnd]
  assumptions: string[];            // defaults the parser filled in, shown to the user
}

// ---------- evidence ----------

export interface SourceRef {
  provider: 'crustdata' | 'web' | 'seller_profile' | 'derived';
  endpoint: string;                 // e.g. "/job/search"
  recordId?: string;                // id of the record inside the response
  field?: string;                   // json path of the field that carries the fact
  url?: string;                     // public URL (job post, linkedin, article) if any
}

export interface Evidence {
  id: string;                       // 'ev_xxx'
  claim: string;                    // human sentence: "Alpha Speech posted 'Senior Inference Engineer'"
  value?: string | number | null;   // the atomic value the claim rests on
  source: SourceRef;
  observedAt: IsoDate | null;       // when the fact happened / was true. null => undated
  retrievedAt: IsoDateTime;         // when DOMINO fetched it
  mode: DataMode;                   // live / cache / fixture (synthetic)
  verifiable: boolean;              // false => "I can't verify" (undated or unsourced)
}

// ---------- entities ----------

export interface Company {
  id: string;                       // canonical 'co_xxx'
  name: string;
  aliases: string[];                // every name it appeared under
  domain?: string | null;
  linkedinUrl?: string | null;
  crustdataId?: number | string | null;
  industry?: string | null;
  headcount?: number | null;
  headcountGrowthPct?: { window: '1m' | '3m' | '6m' | '12m'; pct: number } | null;
  hq?: string | null;
  foundedYear?: number | null;
  lastFunding?: { date: IsoDate | null; round?: string | null; amountUsd?: number | null } | null;
  competitorIds?: string[];         // canonical ids of known competitors/peers
  evidenceIds: string[];
}

export interface Person {
  // Minimal personal data: name, title, employer, public profile URL, role dates. No emails/phones.
  id: string;                       // 'pe_xxx'
  name: string;
  title: string;
  companyId: string | null;
  linkedinUrl?: string | null;
  startedAt?: IsoDate | null;       // start of current role
  pastEmployers: { name: string; companyId?: string | null; from?: IsoDate | null; to?: IsoDate | null; title?: string | null }[];
  evidenceIds: string[];
}

export interface MergeDecision {
  canonicalId: string;
  kind: 'company' | 'person';
  names: string[];                  // the raw names that became one record
  reason: string;                   // "same domain sarvam.ai and same Crustdata id 123"
  keys: string[];                   // matching keys used
}

export interface KeptApartDecision {
  kind: 'company' | 'person';
  ids: string[];
  names: string[];
  reason: string;                   // "same name, different domains (alpha.ai vs alpha.health)"
}

// ---------- triggers & cascade ----------

export type TriggerKind = 'job_post' | 'hire' | 'departure' | 'headcount_jump' | 'funding' | 'post';

export interface Trigger {
  id: string;                       // 'tr_xxx'
  companyId: string;
  kind: TriggerKind;
  date: IsoDate;                    // inside the run window
  summary: string;
  relatedCompanyId?: string | null; // for hires/departures: the other company
  personId?: string | null;
  evidenceIds: string[];
}

// Cross-company mechanisms are the product. DIRECT is first-order (Avina-style) and is kept mainly as the BASELINE.
//  TALENT_DRAIN: B hired >=2 of A's infra/inference people inside the window  -> A needs managed inference (can't rebuild in-house fast)
//  DISPLACEMENT: a provider A was acquired / shut down / repriced (dated source) -> companies whose dated job posts name A's product must migrate
//  CONTAGION:    A (a peer/competitor of C) made a dated infra move; C shows the same profile but no infra hiring yet -> C likely follows
//  CAPITAL:      dated funding round at the company -> budget exists (supporting evidence, never fires alone)
//  DIRECT:       the company itself posts infra/inference roles (first-order baseline)
export type Mechanism = 'TALENT_DRAIN' | 'DISPLACEMENT' | 'CONTAGION' | 'CAPITAL' | 'DIRECT';

export interface GraphNode {
  id: string;                       // company id
  name: string;
  tier: number;                     // 0 = trigger company, 1 = first downstream, 2 = second...
  need: string | null;              // predicted need, e.g. "managed inference (buy vs build)"
  confidence: number | null;        // 0..1, null for pure trigger nodes
  mechanisms: Mechanism[];
  netNew: boolean;                  // a plain hiring filter would NOT have returned this company
  triggerIds: string[];
  evidenceIds: string[];
  status: 'hypothesis' | 'unverifiable';
}

export interface GraphEdge {
  id: string;                       // 'ed_xxx'
  from: string;                     // company id where the change happened
  to: string;                       // company id where the need is predicted
  mechanism: Mechanism;
  label: string;                    // short edge text shown on the canvas
  rationale: string;                // one paragraph, why this edge implies the need
  alternative?: string | null;      // the competing explanation we could not rule out ("hiring may be cost-cutting")
  confidence: number;               // 0..1
  observedAt: IsoDate | null;       // latest dated evidence on this edge
  evidenceIds: string[];
  order: number;                    // animation order in the cascade (0 first)
}

export interface CascadeGraph { nodes: GraphNode[]; edges: GraphEdge[] }

// ---------- targets, deciders, paths, drafts ----------

export interface Decider {
  personId: string;
  name: string;
  title: string;
  tenureSince?: IsoDate | null;
  reason: string;                   // why this person owns the decision
  evidenceIds: string[];
}

export interface WarmPath {
  strength: 'warm' | 'lukewarm' | 'cold';
  score: number;                    // 0..1
  hops: { label: string; kind: 'you' | 'teammate' | 'customer' | 'shared_employer' | 'alumni' | 'trigger' | 'decider' }[];
  explanation: string;
  evidenceIds: string[];
}

export interface Target {
  companyId: string;
  rank: number;                     // 1 = best
  score: number;                    // 0..1 final ranking score
  confidence: number;               // 0..1 cascade confidence
  need: string;
  mechanisms: Mechanism[];
  netNew: boolean;
  whyNow: string;
  whyNowDate: IsoDate | null;
  decider: Decider | null;          // null => "no decider found, I can't verify who decides"
  path: WarmPath | null;
  draftId: string | null;
  // False-drain guards. Any reason => the account is put on Hold: shown with its reasons, never drafted or sent.
  // Reasons: acquisition/acqui-hire, shared parent, >40% of headcount moving, ambiguous company id,
  // month-only dates that cannot settle the window, unrecognised titles.
  hold?: { reasons: string[] } | null;
  // What the replay tests for this account: e.g. "serving staffing activity at Orbital Voice within 60 days".
  testedClaim?: string | null;
}

export interface DraftSentenceCheck {
  sentence: string;
  status: 'cited' | 'no_claim' | 'removed';
  evidenceIds: string[];
  note?: string;
}

export interface Draft {
  id: string;                       // 'dr_xxx'
  companyId: string;
  personId: string | null;
  subject: string;
  body: string;                     // claims carry markers like [1] [2]
  citations: { marker: number; evidenceId: string }[];
  unverifiable: { claim: string; reason: string }[];  // "I can't verify" list, never in the body
  checks: DraftSentenceCheck[];
  generator: string;                // 'llm:claude-haiku-5-5' | 'template'
  verified: boolean;                // every factual sentence cites evidence
  meeting: { title: string; durationMin: number; proposedSlots: IsoDateTime[] };
}

// ---------- approvals & actions ----------

export type ApprovalKind = 'send_message' | 'book_meeting';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;                       // 'ap_xxx'
  runId: string;
  companyId: string;
  draftId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  idempotencyKey: string;           // sha256(run|company|person|draft body) first 16 hex
  createdAt: IsoDateTime;
  decidedAt?: IsoDateTime | null;
  decidedBy?: string | null;
}

export interface DeliveryReceipt {
  // The test-inbox receiver keeps its own UNIQUE index on the send key, so even a sender that crashed after the
  // receiver accepted (and before recording it) cannot deliver twice: the retry gets 'already_delivered'.
  idempotencyKey: string;
  status: 'delivered' | 'already_delivered';
  receivedAt: IsoDateTime;
}

export interface OutboxAction {
  idempotencyKey: string;
  runId: string;
  approvalId: string;
  kind: ApprovalKind;
  testMode: true;                   // ALWAYS true: DOMINO never really sends or books
  sink: string;                     // e.g. "data/outbox/<key>.eml" or ".ics"
  executedAt: IsoDateTime;
  summary: string;
}

// ---------- cost ledger & budget ----------

export interface LedgerEntry {
  id: number;
  runId: string;
  ts: IsoDateTime;
  step: string;
  provider: 'crustdata' | 'anthropic' | 'openai' | 'template' | 'web';
  endpoint: string;                 // "/job/search" or model id
  mode: DataMode | 'model';
  status: 'ok' | 'timeout' | 'error' | 'nonsense' | 'cache_hit' | 'budget_blocked';
  attempt: number;
  credits: number;                  // Crustdata credits charged (0 for cache/fixture)
  inputTokens: number;
  outputTokens: number;
  usd: number;                      // model cost (and any paid API) in USD
  latencyMs: number;
  injected: boolean;                // true if the failure was injected chaos
}

export interface BudgetState {
  limits: RunLimits;
  used: { credits: number; modelUsd: number; seconds: number };
  exhausted: null | 'credits' | 'model_usd' | 'seconds';
}

// ---------- run state ----------

export type RunStatus =
  | 'queued' | 'running' | 'awaiting_input' | 'awaiting_approval'
  | 'completed' | 'failed' | 'crashed' | 'budget_exhausted';

export const STEP_ORDER = [
  'parse_request',
  'pull_triggers',
  'resolve_entities',
  'enrich_companies',
  'cascade',
  'rank_targets',
  'find_deciders',
  'warm_paths',
  'draft_messages',
  'approval_gate',
  'score_replay',                   // replay runs only; live runs mark it skipped
] as const;
export type StepName = typeof STEP_ORDER[number];

export interface StepState {
  step: StepName;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempt: number;
  startedAt?: IsoDateTime | null;
  finishedAt?: IsoDateTime | null;
  summary?: string | null;
  resumedFromCheckpoint?: boolean;  // true if this step's output was reused after a crash
}

export interface Ask {
  id: string;
  question: string;
  why: string;                      // why the answer changes the result
  options: string[];
  default: string;
  answer?: string | null;
}

export interface RunSnapshot {
  id: string;
  request: string;
  status: RunStatus;
  dataMode: DataMode;
  llm: string;                      // 'anthropic:claude-haiku-5-5' | 'openai:...' | 'template'
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  intent: Intent | null;
  steps: StepState[];
  budget: BudgetState;
  companies: Company[];
  people: Person[];
  triggers: Trigger[];
  merges: MergeDecision[];
  keptApart: KeptApartDecision[];
  graph: CascadeGraph;
  targets: Target[];
  drafts: Draft[];
  evidence: Evidence[];
  approvals: Approval[];
  outbox: OutboxAction[];
  ledger: LedgerEntry[];
  asks: Ask[];
  baseline: { hiringFilterCompanyIds: string[] };   // what a plain "is hiring" filter returns
  engine: { pid: number | null; alive: boolean; crashes: number; resumes: number };
  replay: ReplayScore | null;
}

// ---------- event stream (SSE, append-only, also persisted) ----------

export type RunEvent =
  | { type: 'run.status'; status: RunStatus; note?: string }
  | { type: 'step.started'; step: StepName; label: string; attempt: number }
  | { type: 'step.completed'; step: StepName; summary: string; durationMs: number }
  | { type: 'step.skipped'; step: StepName; reason: 'checkpoint' }
  | { type: 'step.failed'; step: StepName; error: string }
  | { type: 'tool.call'; callId: string; provider: LedgerEntry['provider']; endpoint: string; mode: DataMode | 'model'; attempt: number }
  | { type: 'tool.result'; callId: string; ok: boolean; latencyMs: number; credits: number; usd: number; cached: boolean }
  | { type: 'tool.retry'; callId: string; endpoint: string; reason: 'timeout' | 'http_5xx' | 'rate_limit' | 'nonsense' | 'network'; attempt: number; backoffMs: number; injected: boolean }
  | { type: 'tool.fallback'; callId: string; endpoint: string; from: DataMode; to: DataMode; reason: string }
  | { type: 'ledger.entry'; entry: LedgerEntry }
  | { type: 'budget.update'; budget: BudgetState }
  | { type: 'entity.merged'; merge: MergeDecision }
  | { type: 'entity.kept_apart'; decision: KeptApartDecision }
  | { type: 'evidence.added'; evidence: Evidence[] }
  | { type: 'trigger.found'; trigger: Trigger }
  | { type: 'graph.node'; node: GraphNode }
  | { type: 'graph.edge'; edge: GraphEdge }
  | { type: 'targets.ranked'; targets: Target[]; baseline: { hiringFilterCompanyIds: string[] } }
  | { type: 'decider.found'; companyId: string; decider: Decider | null }
  | { type: 'path.found'; companyId: string; path: WarmPath | null }
  | { type: 'draft.ready'; draft: Draft }
  | { type: 'claim.unverifiable'; companyId: string; claim: string; reason: string }
  | { type: 'ask.requested'; ask: Ask }
  | { type: 'ask.answered'; askId: string; answer: string }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.decided'; approvalId: string; status: ApprovalStatus }
  | { type: 'action.executed'; action: OutboxAction }
  | { type: 'action.duplicate_blocked'; idempotencyKey: string; approvalId: string; note: string }
  | { type: 'delivery.receipt'; receipt: DeliveryReceipt; approvalId: string }
  | { type: 'target.held'; companyId: string; reasons: string[] }
  | { type: 'engine.started'; pid: number; resume: boolean }
  | { type: 'engine.crashed'; pid: number; atStep: StepName | null; signal: string | null }
  | { type: 'engine.resumed'; fromStep: StepName; skipped: StepName[] }
  | { type: 'replay.outcome'; outcome: ReplayOutcome }
  | { type: 'replay.scored'; score: ReplayScore }
  | SourceReadEvent
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

// ---------- replay scoring ----------

export interface ReplayOutcome {
  companyId: string;
  predictedBy: 'domino' | 'baseline_first_order' | 'baseline_headcount' | 'both';
  hit: boolean;                     // the company SHOWED the need after asOf (dated infra/inference hire or job post)
  outcomeDate: IsoDate | null;
  outcome: string;                  // "posted 'Inference Platform Engineer' 14 Oct" | "no dated sign yet"
  evidenceIds: string[];
}

export interface ReplayScore {
  asOf: IsoDate;
  horizonEnd: IsoDate;
  factsAfterAsOfUsed: number;       // must be 0: every evidence row used for prediction has observedAt <= asOf
  domino: { predicted: number; hits: number; precision: number; medianLeadDays: number | null };
  baselineFirstOrder: { predicted: number; hits: number; precision: number; medianLeadDays: number | null };
  baselineHeadcount: { predicted: number; hits: number; precision: number; medianLeadDays: number | null };
  outcomes: ReplayOutcome[];
  note: string;                     // honest one-liner, including when DOMINO loses to a baseline
  snapshotLabel?: string;           // "Not point-in-time: today's Crustdata index, filtered to facts dated on or before 1 Sep"
  outcomeDefinition?: string;       // frozen before outcomes were looked at (see README "Replay protocol")
}

// What the agent actually read on one tool call, for the run theatre. Emitted after every Crustdata / web / posts
// call (live, cache or fixture: `mode` says which). Items are capped (~12) and carry only public business facts.
export interface SourceItem {
  kind: 'job_post' | 'person_move' | 'company' | 'funding' | 'headcount' | 'post' | 'news' | 'decider';
  title: string;                    // job title, post headline, company name, "Engineer moved A -> B" (no person names for moves)
  company: string | null;           // company the item is about
  url: string | null;               // public source URL if any
  date: IsoDate | null;             // date of the fact (month-precision dates use the 1st, see `precision`)
  precision?: 'day' | 'month' | null;
  signal: string | null;            // what DOMINO extracted: "serving role posted", "infra engineer left", "Series B raised"
  matched: boolean;                 // true if it fed a trigger/edge; false = read and discarded (shown dimmed)
}

export interface SourceReadEvent {
  type: 'source.read';
  callId: string;
  step: StepName;
  endpoint: string;                 // 'job_search', 'person_recent_moves', 'company_posts', ...
  mode: DataMode;
  query: string;                    // human summary of the query: "serving/inference job posts, 23 Oct-22 Nov"
  totalAvailable: number | null;    // total_count reported by the source
  items: SourceItem[];
}

export interface StoredEvent { seq: number; runId: string; ts: IsoDateTime; event: RunEvent }
