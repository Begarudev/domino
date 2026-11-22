# Live-data scripts (22 Nov 2026)

These reproduce the numbers in docs/LIVE-DATA.md. Each script reads the key from the environment and writes raw responses to the directory you pass, or to `replay/`, `o1/`, `news/`, `jobs/` under the current directory. Each response is cached with `retrievedAt`, and a cached file is never fetched again. Run them from a scratch directory outside the repo and keep raw person pages out of git.

    bun --env-file=../.env scripts/live/fetch-funnel.ts OUTDIR      # 1,410-profile live departures pull (paced for person-search 429s)
    bun --env-file=../.env scripts/live/fetch-replay.ts OUTDIR      # 2,456-profile pull for the 1 Sep replay window
    python3 scripts/live/o1.py merged.json 2026-11-22 out.json      # O1 groups, live
    python3 scripts/live/o1.py merged.json 2026-09-01 out.json 30   # O1 groups as of 1 Sep, with the 30-day profile lag
    bun --env-file=../.env scripts/live/o1check.ts NAME COMPANY_ID FAMILY SINCE TAG   # no-replacement post and hire checks
    bun --env-file=../.env scripts/live/replay.ts out-universe.json out.json          # 1 Sep replay arms and baselines
    bun --env-file=../.env scripts/live/websearch.ts "QUERY" out.json [start] [end]   # Crustdata news search
