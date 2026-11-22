# DOMINO build contract (read this first)

DOMINO is an Outbound Desk agent (ContextCon 05 theme 9.1, "meetings booked on triggers from the last 30 days").
A request goes in ("We sell managed GPU inference. Find AI companies whose changes in the last 30 days mean they'll
need it, and book me meetings with the people who decide."), and a finished, approval-gated result comes out.

The idea: normal tools flag the company that is hiring. DOMINO also flags the **second domino**: a dated change at
company A creates predicted needs at B, C, D. Every edge is dated evidence; every node is a hypothesis with a confidence.

**Judging-driven design rules (from the red team):**
1. Every headline rule is cross-company (TALENT_DRAIN, DISPLACEMENT, CONTAGION). DIRECT ("A hires infra, so A needs
   infra") is first-order, already sold by Avina/Coldreach, and is kept as the **baseline** we beat.
2. A rule fires only on **>= 2 dated evidence rows**. Undated => "I can't verify".
3. **Replay mode**: freeze the world at `asOf` (default 2026-09-01), use only evidence with `observedAt <= asOf`
   (counter "facts after asOf used: 0"), predict, then `score_replay` checks what happened in `(asOf, horizonEnd]`
   (dated infra/inference hires or job posts) for DOMINO vs the first-order baseline vs a "headcount +30%" filter.
   Report the real numbers even if DOMINO loses.
4. The live run ends in a finished job: one decision-maker per account, a verified first message, human approval, sent
   **once** to the team test inbox (outbox file), meeting hold booked in test mode.
5. Talent moves are shown as counts in the UI and drafts ("3 of your inference engineers moved to ..."), never as a
   named poaching list. Warm-path routing is minor (crowded space); keep it cheap.

All shared types live in `shared/types.ts`. Do not change a type there without the lead; add optional fields only.

## Stack (fixed)

- Bun 1.4 runs TypeScript directly (`bun server/index.ts`); Bun is also the package manager (`bun.lock`). Erasable
  syntax only: no `enum`, no `namespace`, no constructor parameter properties; relative imports end in `.ts`.
- One root `package.json` (no workspaces). Server: `hono`, `@hono/node-server`, `zod`. Web: `vite`, `react`,
  `react-dom`, `@vitejs/plugin-react`, `typescript`, `motion`. Add others only if they clearly pay for themselves.
- SQLite via built-in `node:sqlite` (`DatabaseSync`), file `data/domino.db`, WAL mode, `busy_timeout=5000`.
- Web UI: Vite + React. `web2/` is the Search Desk app (candidate + company), `web/` the original run view; the server
  serves `web2/dist` when `DOMINO_UI=web2`, else `web/dist`.
- Port: `DOMINO_PORT` default `4321`.
- Scripts: `bun start` (install if needed, build the UI if stale, start the server), `bun run dev` (server + vite dev
  with `/api` proxy), `bun run test` (`bun test server`), `bun run test:e2e`, `bun run smoke`, `bun run proof:send-once`.

## Process model (this is what makes kill-and-resume real)

- `server/index.ts` = HTTP API + SSE + static files. It never runs steps itself.
- `server/engine/worker.ts` = the engine, a **child process** forked per run (`child_process.fork`) with `RUN_ID`.
  It executes steps in `STEP_ORDER`, writing everything to SQLite. Kill = `SIGKILL` the child. Resume = fork a new
  child for the same run; it reads `steps` and skips every step whose status is `done` (emitting `step.skipped` with
  reason `checkpoint` and one `engine.resumed`).
- The server streams events to the browser by **tailing the `events` table** (poll every 150 ms per open stream), so
  the stream survives engine crashes.
- When the child exits unexpectedly the server records `engine.crashed` and sets run status `crashed`.
  The UI offers Resume.
- Steps must be idempotent: a step writes its output in one transaction together with `status='done'`. Side effects
  (sends/bookings) happen only through the outbox with an idempotency key (unique index), so replays can't double-send.

## SQLite schema (owned by `server/db.ts`)

```
runs(id TEXT PK, request TEXT, status TEXT, data_mode TEXT, llm TEXT, intent_json TEXT, limits_json TEXT,
     chaos_json TEXT, created_at TEXT, updated_at TEXT, engine_pid INTEGER, crashes INTEGER DEFAULT 0, resumes INTEGER DEFAULT 0)
steps(run_id TEXT, step TEXT, status TEXT, attempt INTEGER, started_at TEXT, finished_at TEXT, summary TEXT,
      output_json TEXT, resumed INTEGER DEFAULT 0, PRIMARY KEY(run_id, step))
events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, type TEXT, payload_json TEXT)
ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, step TEXT, provider TEXT, endpoint TEXT, mode TEXT,
       status TEXT, attempt INTEGER, credits REAL, input_tokens INTEGER, output_tokens INTEGER, usd REAL, latency_ms INTEGER,
       injected INTEGER, request_hash TEXT)
tool_cache(key TEXT PK, provider TEXT, endpoint TEXT, request_json TEXT, response_json TEXT, fetched_at TEXT)
evidence(id TEXT PK, run_id TEXT, json TEXT)
approvals(id TEXT PK, run_id TEXT, json TEXT, status TEXT, idempotency_key TEXT UNIQUE)
outbox(idempotency_key TEXT PK, run_id TEXT, approval_id TEXT, json TEXT, executed_at TEXT)
asks(id TEXT PK, run_id TEXT, json TEXT, answer TEXT)
```
Entities, graph, targets and drafts live in the `output_json` of the step that produced them; the snapshot builder
(`server/snapshot.ts`) assembles a `RunSnapshot` from steps + tables.

## REST + SSE API (owned by `server/index.ts`)

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/health` | `{ ok, dataMode, crustdataKey: boolean, llm: string, version }` |
| POST | `/api/runs` | `{ request, limits?, chaos?, dataMode? }` -> `{ id }` (starts engine) |
| GET | `/api/runs` | `[{ id, request, status, createdAt }]` newest first |
| GET | `/api/runs/:id` | `RunSnapshot` |
| GET | `/api/runs/:id/stream?after=SEQ` | SSE; each message `data: StoredEvent` JSON; heartbeat comment every 10 s |
| POST | `/api/runs/:id/kill` | SIGKILL the engine child (demo of crash) -> `{ killed, pid }` |
| POST | `/api/runs/:id/resume` | fork engine again for this run -> `{ pid }` |
| POST | `/api/runs/:id/limits` | partial `RunLimits`; lowering mid-run is allowed; engine re-reads limits before every paid call |
| POST | `/api/runs/:id/asks/:askId` | `{ answer }` |
| POST | `/api/approvals/:id` | `{ decision: 'approve' \| 'reject' }` -> executes test-mode action through the outbox; a second approve returns `{ duplicate: true }` and emits `action.duplicate_blocked` |
| POST | `/api/evidence/:id/recheck` | re-fetch the source (live if possible) and return updated `Evidence` |

## Steps (owned by `server/engine/steps.ts`, logic delegated to domain modules)

| Step | Does | Domain function(s) |
|---|---|---|
| parse_request | text -> `Intent`; if `offering` is missing, create an `Ask` and wait (status `awaiting_input`) because the answer changes the result; everything else gets a default listed in `intent.assumptions` | `parseIntentRules`, optional LLM |
| pull_triggers | live/cache/fixture Crustdata calls: infra job posts, recent infra hires (with past employer), headcount jumps, recent funding; all inside `windowDays` | `crustdata.*` + `normalize.*` |
| resolve_entities | merge mentions into canonical companies/people; record `MergeDecision` and `KeptApartDecision` | `resolveEntities` |
| enrich_companies | company enrich for the top N companies (headcount, funding, competitors/peers) | `crustdata.enrichCompanies` |
| cascade | build `CascadeGraph` with mechanisms DIRECT / TALENT_DRAIN / CONTAGION / CAPITAL, confidence per edge | `buildCascade` |
| rank_targets | rank `Target`s, compute `netNew` against the plain hiring filter baseline | `rankTargets` |
| find_deciders | person search at each top target for decision-maker titles; pick one with a reason | `crustdata.searchPeople`, `pickDecider` |
| warm_paths | compare decider history with `config/seller.json` (team past employers, existing customers) | `findWarmPath` |
| draft_messages | claims -> draft (LLM if key, else template) -> **verifier** strips any sentence whose facts are not in cited evidence; undated/unsourced claims go to `unverifiable` | `buildClaims`, `templateDraft`, `verifyDraft` |
| approval_gate | create one `send_message` + one `book_meeting` approval per target; run status `awaiting_approval`; run is "finished" when every approval is decided | — |
| score_replay | replay runs only: fetch outcomes after `asOf` (job posts / hires dated in `(asOf, horizonEnd]`) for every DOMINO and baseline pick; compute `ReplayScore`; live runs mark it `skipped` | `scoreReplay` |

## Data modes and the live switch

`DOMINO_DATA=auto|live|cache|fixture` (default `auto` = `live` if `CRUSTDATA_API_KEY` is set, else `fixture`).
- **live**: call Crustdata; on success store the raw response in `tool_cache`; on final failure after retries fall back
  to `tool_cache` (event `tool.fallback`, evidence mode `cache`).
- **cache**: replay `tool_cache` only, zero credits; evidence mode `cache`; a cache miss falls back to fixture with an event.
- **fixture**: synthetic recorded fixtures in `server/crustdata/fixtures/`, **fictional companies only**, evidence mode
  `fixture`; the UI must label it "FIXTURE · synthetic data".
- Never print, log or persist the API key. Read it from `process.env` only. `.env` is loaded by the server at startup
  (tiny parser, no dependency) and inherited by the engine child.
- Crustdata REST: base `https://api.crustdata.com`, headers `Authorization: Bearer $CRUSTDATA_API_KEY`,
  `x-api-version: 2025-11-01`, JSON bodies. Read the `X-Credits-Used` response header when present, else estimate from
  the rate card (search 0.03/result, company enrich 2-4, person enrich 1-9, live search 2/result).

## Tool wrapper (owned by `server/runtime/tool.ts`)

Every external call (Crustdata, LLM) goes through `ctx.tool(...)`, which provides: per-call timeout (default 12 s,
AbortController), up to 3 attempts with exponential backoff + jitter on timeout / 5xx / 429 / network / nonsense
(schema-invalid body, validated with zod by the caller-supplied parser), chaos injection (`ChaosConfig`, first attempt
only, `injected: true`), budget check **before** the call (`budget_blocked` ledger row + run status `budget_exhausted`
when a ceiling is hit, with a partial result), a ledger row for **every attempt** (including cache hits at 0 credits
and fixture calls at 0 credits), and events `tool.call` / `tool.result` / `tool.retry` / `tool.fallback` / `ledger.entry` / `budget.update`.

## LLM (owned by `server/llm/client.ts`)

Provider chosen at startup: `ANTHROPIC_API_KEY` -> Anthropic Messages API via fetch (`claude-haiku-5-5` for parsing,
`claude-sonnet-5-5` for drafting); else `OPENAI_API_KEY`; else `template` (no model, deterministic). Every model call is
a ledger row with tokens and USD. The LLM never invents facts: it receives a numbered claim list and must cite `[n]`;
the verifier is the authority.

## Module boundaries (who writes what)

- **core** worker: `package.json`, `server/index.ts`, `server/db.ts`, `server/env.ts`, `server/snapshot.ts`,
  `server/engine/**`, `server/runtime/**`, `server/llm/**`, `server/actions/**` (outbox, .eml/.ics writer to `data/outbox/`), scripts.
- **data** worker: `server/crustdata/**` (client request builders, zod parsers/normalizers, fixtures),
  `server/domain/**` (intent rules, entity resolution, cascade, ranking, deciders, warm paths, claims, template drafter,
  verifier) with unit tests, `config/seller.json`.
- **web** worker: `web/**` only.
- The lead owns `shared/types.ts`, `docs/**`, README, and merges.

## Domain function signatures (implemented by data worker, called by core worker)

```ts
// server/domain/index.ts re-exports all of these
parseIntentRules(text: string, asOf: IsoDate): Intent
resolveEntities(mentions: CompanyMention[], people: PersonMention[]): { companies: Company[]; people: Person[]; merges: MergeDecision[]; keptApart: KeptApartDecision[]; idMap: Record<string, string> }
buildCascade(intent: Intent, triggers: Trigger[], companies: Company[], evidence: Evidence[]): CascadeGraph
rankTargets(intent: Intent, graph: CascadeGraph, companies: Company[], triggers: Trigger[]): { targets: Target[]; baseline: { hiringFilterCompanyIds: string[] } }
pickDecider(intent: Intent, company: Company, candidates: Person[]): Decider | null
findWarmPath(decider: Decider, person: Person, company: Company, seller: SellerProfile, triggers: Trigger[], companies: Company[]): WarmPath | null
buildClaims(target: Target, company: Company, triggers: Trigger[], evidence: Evidence[], graph: CascadeGraph): Claim[]
templateDraft(target: Target, decider: Decider | null, claims: Claim[], seller: SellerProfile): Draft
llmDraftPrompt(target: Target, decider: Decider | null, claims: Claim[], seller: SellerProfile): { system: string; user: string }
verifyDraft(draft: { subject: string; body: string }, claims: Claim[], evidence: Evidence[]): Pick<Draft, 'body' | 'citations' | 'checks' | 'unverifiable' | 'verified'>
filterAsOf(evidence: Evidence[], asOf: IsoDate): { kept: Evidence[]; dropped: number }   // replay guard
scoreReplay(intent: Intent, targets: Target[], baseline: { firstOrder: string[]; headcount: string[] }, outcomes: OutcomeFact[]): ReplayScore

// server/crustdata/index.ts
// Each endpoint module exports a request builder and a parser. The parser validates with zod and throws
// `NonsenseError` on schema-invalid input; it returns normalized mentions + evidence.
jobSearch.build(intent): { path: string; body: unknown }       jobSearch.parse(raw, ctx): { mentions; triggers; evidence }
personSearchRecentMoves.build(intent) / .parse(...)             -> hires with past employer (talent moves)
companySearchGrowth.build(intent) / .parse(...)                 -> headcount jumps / funding
companyEnrich.build(companyKeys[]) / .parse(...)                -> firmographics, competitors/peers
personSearchDeciders.build(intent, company) / .parse(...)       -> decider candidates
fixtureFor(path: string, body: unknown): unknown                -> synthetic raw response in the real response shape
```

`CompanyMention`, `PersonMention`, `Claim`, `SellerProfile` are defined in `server/domain/types.ts` by the data worker.

## Non-negotiables

- Never really send email/messages/calendar invites. Outbox writes `.eml` / `.ics` files to `data/outbox/` only, `testMode: true`.
- Never commit secrets; `.env` is gitignored. `data/` is gitignored except `data/cache-snapshot/` (committed cached live responses for the demo).
- Minimal personal data: names, titles, employers, role dates, public profile URL. No emails or phone numbers.
- Undated or unsourced facts are never stated as fact: they go to "I can't verify".

## Centrepiece slot (web)

The middle of the main screen is a **slot** so rival centrepieces (3D physics table, talent-flow time-lapse, mission
control) can mount without touching the rest of the app. The web app owns run flow, approvals, ledger, drawer and
plumbing; a centrepiece only renders and reports selections.

`web/src/centrepiece/contract.ts`:

```ts
import type { RunSnapshot, StoredEvent } from '../../../shared/types.ts';

export type Selection =
  | { kind: 'node'; id: string }        // GraphNode.id (company id)
  | { kind: 'edge'; id: string }        // GraphEdge.id
  | { kind: 'target'; id: string }      // Target.companyId
  | { kind: 'evidence'; id: string };   // Evidence.id

export interface CentrepieceProps {
  snapshot: RunSnapshot;                // reduced live state (graph, targets, evidence, replay, ...)
  events: StoredEvent[];                // every event so far, in seq order (for time-lapse / animation)
  running: boolean;                     // engine is working right now
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;   // opens the evidence drawer
  hiringFilterView: boolean;            // show only what a plain hiring filter finds: dim the rest, stamp it "missed by a hiring filter"
  reducedMotion: boolean;
  width: number;                        // slot size in CSS px (about 780 x 540 at 1440 x 900)
  height: number;
  replayToken: number;                  // increments when the user presses "Replay cascade"
}

export interface CentrepieceModule {
  id: string;                           // 'table' | 'physical' | 'flow' | 'mission'
  label: string;
  Component: (props: CentrepieceProps) => JSX.Element;
}
```

`web/src/centrepiece/registry.ts` lists the modules; the app picks one with `?centre=<id>` (default `table`).
A sample event stream that conforms to `shared/types.ts` lives at `docs/sample-run-events.json` (regenerated from a
fixture run) and the UI's mock stream at `web/src/mock/events.ts`.

---

## Search Desk (pivot approved 22 Nov 2026, 14:08 IST)

DOMINO predicts job openings before they are posted, from talent drain, and makes the match with dated proof
(theme 1.1). Types: [`shared/desk.ts`](../shared/desk.ts). Every agent job is a normal **run** with a `pipeline`
(`shared/types.ts` `PIPELINES`), so the journal, checkpoints, kill/resume, ledger, caps, verifier, outbox + receiver
send-once and `source.read` events all apply unchanged. Stream any run at `GET /api/runs/:runId/stream`.

| Pipeline | Steps | Owner |
|---|---|---|
| `outbound` | the original 11 steps (kept, not in the demo) | lead |
| `openings` | scope_search → pull_departures → resolve_departures → check_replacements → detect_openings → score_openings (replay only) | domino-livedata (`server/engine/openings-steps.ts`) |
| `candidate` | fetch_profile → parse_profile → match_openings | domino-desk-api (`server/engine/candidate-steps.ts`) |
| `intro` | draft_intro → intro_gate (approval → delivered once to the team inbox) | domino-desk-api |

### Rule O1 (fixed 14:08 IST after seeing live departure counts, before any replay outcome was looked at)

At company A (20–5,000 staff): **≥ 2 conclusive dated departures in role family F within 90 days**, AND **no dated
replacement hire or dated job post for F at A within 30 days of the last departure** → predicted opening for F at A.

- Role families: `inference`, `ml_platform`, `mlops`, `gpu_llm_infra` (`backend_payments` if cheap).
- **Dates are month-level** (every Crustdata role date is the 1st). A month-only date is the interval [1st, last day];
  each condition is evaluated for every day in it (refined 14:14 IST, before replay outcomes were seen; a strict
  "month-only → Hold" reading makes the rule vacuous on month-level data):
  - drain window: settled → counts; unsettled (straddles the 90-day edge) → **Hold**;
  - no-replacement leg: settled → `open`; unsettled with 0 replacements so far → `open` with a *provisional* reason
    "replacement window closes by <date>"; any replacement found → no opening.
- **Hold** (`status: 'held'`, `holdReasons`): acquisition / acqui-hire (news source, acquirer = departure destination,
  ±120 days, article cited), shared parent, > 40% of headcount moving, ambiguous company id, unsettled dates,
  unrecognised titles, **possible restructure** (headcount down > 10% over 90 days, or dated layoff/restructure news).
- **Watch** (`status: 'watch'`): exactly 1 departure (`watch.have = 1, need = 2`), or **stale job data** (A's job search
  failed or is > 14 days old: "I can't verify no replacement was posted"). Never `open`.
- People who left appear only as **role + initial + date** (`Departure`), never full names or profile URLs.
- Replay (as of 1 Sep): outcome = a dated job post or hire for F at A within 60 days after the prediction date.
  Baselines: headcount +30%, any job post in the last 30 days. Raw counts, snapshot label, "0 facts after 1 Sep".

### HTTP API (all JSON; responses that cite evidence ids include `evidence: Evidence[]`)

| Method and path | Body | Returns |
|---|---|---|
| `POST /api/openings/scan` | `{ request?, replay?: { asOf } }` | `{ runId }` (openings pipeline) |
| `GET /api/companies` | | `CompanySummary[]` from the latest completed openings scan |
| `GET /api/companies/:id` | | `CompanyView` (departures, openings, matches, intros, runId, replay, evidence) |
| `POST /api/candidates` | `{ linkedinUrl, samples?: string[], consent: Consent }` | `{ candidateId, runId }` (candidate pipeline; live person enrich) |
| `GET /api/candidates/:id` | | `Candidate` |
| `POST /api/candidates/:id/confirm` | `{ consent? }` | `Candidate` (confirmed; consent re-recorded) |
| `GET /api/candidates/:id/openings` | | `OpeningForCandidate[]` ranked for the candidate, each with `fit` |
| `GET /api/candidates/:id/inbox` | | `IntroRequest[]` (companies reaching out) |
| `POST /api/candidates/:id/intros` | `{ openingId }` | `IntroRequest` (candidate consents → intro pipeline run → company approval) |
| `POST /api/companies/:id/intros` | `{ candidateId, openingId }` | `IntroRequest` (company → candidate; only `discoverable` candidates) |
| `POST /api/approvals/:id` | `{ decision: 'approve' \| 'reject' }` | existing endpoint: approval delivers once; a retry says "already delivered, skipped" |
| `POST /api/runs/:id/kill`, `/resume` | | existing endpoints (kill and resume any pipeline run) |

Privacy: candidates opt in with their own profile; only consented fields are stored or shown; no emails or phones.

### Company dossier (full company analysis stays in the product; Garud, 14:19)

`GET /api/companies/:id/dossier[?run=<runId>]` → `CompanyDossier` (`shared/desk.ts`), built from the latest
completed/awaiting-approval **analysis run** (the `outbound` pipeline: triggers, entity resolution, cascade rules
TALENT_DRAIN (R1) / DISPLACEMENT / CONTAGION / CAPITAL / DIRECT, watchlist and Hold, deciders, drafts, approvals,
outbox) that contains the company, plus the openings of the latest `openings` scan. Fields:
`timeline` (dated news/posts, funding, headcount jumps, hires, departures; newest first), `jobPosts`, `talentFlows`
(in/out, **role + initial + date** only, one row per move), `chains` (cross-company edges where the company is the
`cause` or the `effect`, with rationale, alternative explanation, confidence), `predictedNeeds` (status
target/held/watch with hold reasons), `openings`, `outreach` (decider, verified draft, verifier result: removed
sentences and "I can't verify" claims, approvals, outbox actions sent once), `evidence` (every cited row).
Company ids are canonical (`co_…`, stable for the same Crustdata id/domain); an alias name is also accepted.
Start an analysis run with the existing `POST /api/runs {request}` and approve with `POST /api/approvals/:id`.

### Rules registry

`GET /api/rules` → `RuleCard[]` (`shared/desk.ts`): O1, R1, CONTAGION, DISPLACEMENT, DIRECT, each with its statement,
thresholds, guards, lock time and live fire counts (O1 from the latest openings scan: open / provisional / held /
watch; R1/CONTAGION/DISPLACEMENT/DIRECT from the latest analysis run).
