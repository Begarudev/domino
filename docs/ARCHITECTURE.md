# DOMINO architecture

One product in two parts on one signal, dated moves between companies: (1) hiring, a search desk that predicts job openings before they are posted and makes the match with dated proof; (2) company analysis, with news, talent flows, cross-company chains, predicted needs and verified outreach. GitHub renders the diagram below from [`architecture.mmd`](architecture.mmd); the full explanation is in the [README](../README.md#architecture-data-state-and-hosting).

```mermaid
flowchart LR
  subgraph Browser["Browser · React UI · persona switcher"]
    CAND["Candidate<br/>onboard + consent · likely hiring for you<br/>request intro · companies reaching out"]
    HIRE["Company · hiring<br/>drain monitor · predicted openings<br/>matched candidates · intro outreach"]
    INTEL["Company · analysis<br/>news + talent flows · cross-company chains<br/>predicted needs · verified outreach"]
    SHARED["Ledger · replay · live activity feed"]
  end

  subgraph Server["server/index.ts · Hono"]
    API["REST API"]
    SSE["SSE stream<br/>tails the events table"]
    GATE["Approval gate<br/>reserve in one transaction"]
    DISPATCH["Dispatcher<br/>child process per delivery"]
    INBOX["Test inbox receiver<br/>unique idempotency key"]
  end

  subgraph Engine["engine · child process per run · checkpoint per step"]
    direction TB
    SIG["Dated signals<br/>departures from → to · job posts<br/>growth · funding · posts/news"]
    RES["Entity resolution<br/>merge on id/domain, keep namesakes apart"]
    GUARD["False-drain guards<br/>acqui-hire · shared parent · team lift<br/>ambiguous id · month-level intervals"]
    O1["Part 1 · rule O1<br/>open · provisional · watch · held"]
    PROF["Candidate profile<br/>live enrich → model parse → confirm"]
    MATCH["Match<br/>role family + skills, every reason cited"]
    CHAIN["Part 2 · R1 TALENT_DRAIN · CONTAGION<br/>DISPLACEMENT · DIRECT baseline"]
    DEC["Rank needs · find the decider"]
    DRAFT["Draft from numbered claims<br/>verifier deletes uncited sentences"]
    REPLAY["Replay scorer<br/>as of 1 Sep, 0 later facts"]
    SIG --> RES --> GUARD
    GUARD --> O1 --> MATCH --> DRAFT
    PROF --> MATCH
    GUARD --> CHAIN --> DEC --> DRAFT
    O1 --> REPLAY
    CHAIN --> REPLAY
  end

  subgraph Tool["runtime/tool.ts · every external call"]
    T["budget check before the call<br/>timeout · retry with backoff<br/>schema check · ledger row per attempt<br/>live → cache (never live → fixture)"]
  end

  DB[("SQLite data/domino.db<br/>runs · checkpoints · events · ledger<br/>tool_cache · evidence · approvals<br/>outbox · inbox_received")]
  CD["Crustdata API<br/>person enrich/search · job search<br/>company search/enrich · posts"]
  LLM["OpenAI gpt-6-luna<br/>(Anthropic optional)"]
  FX["Fixture world<br/>only when no key or DOMINO_DATA=fixture"]

  CAND --> API
  HIRE --> API
  INTEL --> API
  API -->|fork · kill · resume| Engine
  Engine --> Tool
  Tool --> CD
  Tool --> LLM
  Tool -.-> FX
  Engine -->|output + done in one transaction| DB
  Tool -->|ledger · cache| DB
  DB --> SSE --> SHARED
  HIRE -->|approve intro| GATE
  INTEL -->|approve message| GATE
  GATE -->|outbox row: pending| DB
  GATE --> DISPATCH --> INBOX
  INBOX -->|insert once per key| DB
```

**Flow.** A candidate onboards with their LinkedIn URL and consent (live Crustdata person enrich, model parse, confirmation). The engine reads dated departures across a cohort of AI companies, resolves entities, applies shared false-drain guards, then rule O1 (open, provisional, watch, held) to match opted-in candidates to predicted openings with cited fit reasons, and the cross-company rules (R1 talent drain, contagion, displacement, with a first-order hiring baseline) to rank company needs and find the decider. Every intro or outreach draft is written only from numbered, dated claims and checked by a verifier. A person approves it, and it is delivered once to a test inbox under an idempotency key. Every external call goes through one wrapper that enforces budgets, timeouts, retries and schema checks and writes a ledger row per attempt. State lives in SQLite, with a checkpoint per step, so a killed engine resumes without repeating calls.
