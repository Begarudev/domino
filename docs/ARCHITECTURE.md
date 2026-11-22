# DOMINO architecture

A search desk that predicts job openings before they are posted and makes the match with dated proof. GitHub renders the diagram below from [`architecture.mmd`](architecture.mmd); the full explanation is in the [README](../README.md#architecture-data-state-and-hosting).

```mermaid
flowchart LR
  subgraph Browser["Browser · React UI · persona switcher"]
    CAND["Candidate<br/>onboard + consent · likely hiring for you<br/>request intro · companies reaching out"]
    COMP["Company<br/>drain monitor · predicted openings<br/>matched candidates · outreach · ledger · replay"]
    FEED["Live activity feed"]
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
    P["Candidate profile<br/>live person enrich → model parse → confirm"]
    D["Departures in the cohort<br/>role family, from → to, dated"]
    R["Entity resolution<br/>merge on id/domain, keep namesakes apart"]
    O["Rule O1 + guards<br/>open · provisional · watch · held"]
    M["Match<br/>role family + skills, every reason cited"]
    W["Intro draft<br/>model writes from numbered claims<br/>verifier deletes uncited sentences"]
    S["Replay scorer<br/>as of 1 Sep, 0 later facts"]
    P --> M
    D --> R --> O --> M --> W
    O --> S
  end

  subgraph Tool["runtime/tool.ts · every external call"]
    T["budget check before the call<br/>timeout · retry with backoff<br/>schema check · ledger row per attempt<br/>live → cache (never live → fixture)"]
  end

  DB[("SQLite data/domino.db<br/>runs · checkpoints · events · ledger<br/>tool_cache · evidence · approvals<br/>outbox · inbox_received")]
  CD["Crustdata API<br/>person enrich/search · job search<br/>company search/enrich · posts"]
  LLM["OpenAI gpt-6-luna<br/>(Anthropic optional)"]
  FX["Fixture world<br/>only when no key or DOMINO_DATA=fixture"]

  CAND --> API
  COMP --> API
  API -->|fork · kill · resume| Engine
  Engine --> Tool
  Tool --> CD
  Tool --> LLM
  Tool -.-> FX
  Engine -->|output + done in one transaction| DB
  Tool -->|ledger · cache| DB
  DB --> SSE --> FEED
  COMP -->|approve intro| GATE
  GATE -->|outbox row: pending| DB
  GATE --> DISPATCH --> INBOX
  INBOX -->|insert once per key| DB
```

**Flow.** A candidate onboards with their LinkedIn URL and consent (live Crustdata person enrich, model parse, confirmation). The engine reads dated departures across a cohort of AI companies, resolves entities, applies rule O1 with its false-drain guards (open, watch, held), and matches opted-in candidates to open predictions with cited fit reasons. An intro draft is written only from numbered, dated claims and checked by a verifier. A person approves it, and it is delivered once to a test inbox under an idempotency key. Every external call goes through one wrapper that enforces budgets, timeouts, retries and schema checks and writes a ledger row per attempt. State lives in SQLite, with a checkpoint per step, so a killed engine resumes without repeating calls.
