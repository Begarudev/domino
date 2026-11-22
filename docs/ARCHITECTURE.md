# DOMINO architecture

One product in two parts on one signal, dated moves between companies: (1) hiring, a search desk that predicts job openings before they are posted and makes the match with dated proof; (2) company analysis, with news, talent flows, cross-company chains, predicted needs and verified outreach. GitHub renders the diagram below from [`architecture.mmd`](architecture.mmd); the full explanation is in the [README](../README.md#architecture-data-state-and-hosting).

```mermaid
flowchart LR
  LOGIN(["Sign in<br/>choose role"])

  subgraph CAPP["Candidate app · web2 (React + Vite + motion)"]
    C1["Onboarding<br/>LinkedIn · live enrich · consent"]
    C2["Dashboard<br/>companies likely hiring you · intros"]
  end

  subgraph COAPP["Company app · web2 (React + Vite + motion)"]
    K1["Act<br/>Recruitment · Outreach"]
    K2["Read<br/>Reading log · Company file · Chains · Verifier"]
    K4["Check<br/>Replay · Ledger"]
  end

  subgraph API["Bun API · Hono"]
    DESK["Desk routes<br/>+ SSE events"]
    RUN["Run runtime<br/>journal · checkpoints<br/>kill / resume"]
    R["Rules engine<br/>O1 · R1 · CONTAGION<br/>DISPLACEMENT"]
    G["Guards<br/>acqui-hire from news · restructure<br/>stale data · month-interval dates"]
    VER["Verifier<br/>cites or deletes"]
    LED["Ledger<br/>credits · tokens · USD · caps"]
    OUT["Outbox<br/>approve → idempotency key"]
    RCV["Receiver<br/>send once · team test inbox"]
    RED["Redaction<br/>people as role + initial<br/>journal · API · SSE"]
    DB[("SQLite")]
  end

  subgraph EXT["External"]
    CD["Crustdata<br/>person search/enrich · company<br/>job search · web search/news · credits"]
    LLM["OpenAI GPT-6 Luna<br/>parse · refine · draft only"]
  end

  LOGIN -->|candidate| C1 --> C2
  LOGIN -->|company| K1
  K1 --- K2 --- K4
  C2 --> DESK
  K1 --> DESK
  K2 --> DESK
  K4 --> DESK
  DESK --> RUN --> R
  G -.->|hold| R
  R --> VER --> OUT --> RCV
  RUN --> RED --> DB
  DESK --> RED
  RUN --> LED
  OUT --> DB
  RCV --> DB
  LED --> DB
  RUN --> CD
  RUN --> LLM
  CD -.->|credits| LED
  LLM -.->|tokens| LED
```

**Flow.** A candidate onboards with their LinkedIn URL and consent (live Crustdata person enrich, model parse, confirmation). The engine reads dated departures across a cohort of AI companies, resolves entities, applies shared false-drain guards, then rule O1 (open, provisional, watch, held) to match opted-in candidates to predicted openings with cited fit reasons, and the cross-company rules (R1 talent drain, contagion, displacement, with a first-order hiring baseline) to rank company needs and find the decider. Every intro or outreach draft is written only from numbered, dated claims and checked by a verifier. A person approves it, and it is delivered once to a test inbox under an idempotency key. Every external call goes through one wrapper that enforces budgets, timeouts, retries and schema checks and writes a ledger row per attempt. State lives in SQLite, with a checkpoint per step, so a killed engine resumes without repeating calls.
