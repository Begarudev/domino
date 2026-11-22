# Live yield check for the talent-drain rule (22 Nov 2026, 13:43 IST)

Question: how many accounts does R1 (an AI company loses its 3rd infra/serving engineer to other companies, the 3rd
inside the last 30 days) produce on live Crustdata data right now? Rules and thresholds were fixed before counting.

Query: `POST /person/search`, `x-api-version: 2025-11-01`, filters
`experience.employment_details.past.title` phrase-OR {inference, serving, ML platform, ML infrastructure, MLOps, GPU,
LLM infrastructure, AI infrastructure, ML systems, machine learning platform, machine learning infrastructure, model
deployment} AND `experience.employment_details.current.start_date >= 2026-08-24`. 1,200 of 1,410 profiles fetched
(6 pages of 200; the 7th page hit the endpoint rate limit). Cost: 276 credits.

| Funnel step | Count |
|---|---|
| People with an infra/serving past title and a new role since 24 Aug | 1,410 (1,200 fetched) |
| Direct moves (previous role ended <= 60 days before the new one) | 649 |
| ...whose previous role itself was infra/serving (hardware design and non-engineering titles excluded) | 233 |
| ...from a company with <= 5,000 staff (giants excluded) | 120 |
| Distinct companies that lost someone | 118 |
| Companies with >= 2 such departures | **2** (Poolside: 2 inference engineers, both to NVIDIA, Sep 2026; Abacus.AI: 2 ML-platform engineers, Oct and Nov 2026) |
| Companies with >= 3 (R1 fires) | **0** |

What we learned:
- Crustdata role dates are month precision (`2026-11-01` means November). A 30-day window can only be settled when
  the whole month is inside it, so October moves are ambiguous on 22 Nov.
- Talent drains of three or more serving engineers from one company in a quarter are rare in public data. R1 stays at
  3 (the threshold was fixed before counting). Accounts at 2 of 3 are shown on a **watchlist** with their dated
  evidence and are never drafted; the card fires on the 3rd departure.
- The first query attempt returned zero because it combined filters that matched nothing; counting the funnel step by
  step found it. `experience.employment_details.past.company_id` takes Crustdata company ids; sorting on
  `current.start_date` is not supported; person search allows only a few requests per minute.
