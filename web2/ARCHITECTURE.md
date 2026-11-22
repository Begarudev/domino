# DOMINO UI v2 (web2/): how it's put together

DOMINO is a Search Desk: it predicts job openings before they're posted (rule O1: two or more dated departures in
one role family within 90 days, and no dated replacement hire or job post), then makes the candidate–company match
with dated proof. It's a **product the user drives**, not an auto-playing pipeline. The agent's work stays visible in
the activity rail on the right.

Run it: `bun run dev:web2` serves http://127.0.0.1:5180 (`WEB2_PORT` changes the port; `DOMINO_API` sets the
server, default http://127.0.0.1:4321). Modes: live (default), `?mode=sample` (docs/sample-run-events.json,
labelled), `?mode=mock` (labelled). `?run=<id>` attaches the rail to a run; add `&play=1` to pace a finished run.

## Routes
- `/candidate`: onboarding until this device has a candidate, then the dashboard. `/candidate/onboard` always onboards.
- `/company`: the cohort (companies with a talent drain).
- `/company/:id/:tab`: `openings | drain | matches | analysis | outreach | ledger | replay`. `:id` is a co_ id or a
  name slug ("abacus-ai").

## Data (never invent a number)
- `src/data/desk.ts`: Search Desk types (re-exported from shared/desk.ts) and `deskApi`. Each call tries the live
  endpoint and falls back to a **labelled fixture** only when the endpoint doesn't exist (404 or SPA HTML). Every
  result is `Sourced<T> = { data, source: 'live'|'cache'|'fixture'|'sample', evidence: Evidence[] }`.
- `src/data/query.ts`: `useQuery(key, () => deskApi.x())` returns a cached result that keeps its identity until a
  refetch; `invalidate(prefix)` refetches. Show `<SourceNote source error />` at the top of a panel.
- `src/data/store.ts`: the run store. It reuses web/src/state.ts `reduce` and web/src/api.ts backends unchanged.
  Events are flushed once per requestAnimationFrame (a 6 ms budget). Read slices with
  `useRunSel(v => v.ui.snap.approvals)`, return a field and not a fresh object. Actions: `runStore.attach(runId)`,
  `runStore.decide(approvalId, 'approve')`, `runStore.kill()`, `runStore.resume()`, `runStore.setLimits({maxCredits})`.
  `v.catchingUp` is true for a backlog flush: render it settled, without animating.
- `src/data/derive.ts`: append-only feeds: `v.feeds.sources` (activity cards), `v.feeds.narration` (the Now line),
  `v.feeds.slow` (retry/rate-limit state). `deciderLabel()` gives role plus initial, never a full name.
- `src/lib/format.ts`: every number and date on screen goes through here (`fmtInt`, `fmtPct`, `fmtUsd`, `fmtDate`, ...).
  No raw floats.
- `src/shell/ui.ts`: `openLedger()`, `openEvidence(id)`, `setCandidate(id)`, `useShell(sel)`.

## Smoothness (measured; these are requirements)
- Animate only transform and opacity. No remount per event, no full-list re-render, no long task over 50 ms.
- Lists are append-only with stable keys. Use `useEnterOnce(settled)` from `src/lib/motion.ts` so an entrance runs once.
- Never key text by event seq: key by content, and use `useDwell` for fast-changing lines.
- Never unmount a panel between events (`useSticky`). Never bottom-anchor with justify-content:flex-end.
- Counters use `<Count value format />` (eases via a ref, with no React render per frame).
- No filter: invert or strobes. Respect prefers-reduced-motion (the helpers already do).

## Look
Tokens live in web/src/theme/tokens.css (the one source of truth: colours, type, motion), plus v2 layout tokens in
src/styles/app.css. Use the font Archivo Variable, with the width axis as the voice (`font-variation-settings:
'wdth' 76 | 100 | 125`). Shared classes: `.btn .btn.primary .btn.small .tag(.ok|.warn|.live|.bad) .surface .banner
.h-page .lede .h-sec`. Projector rules: anything that matters is 16px or more; plain words first, with jargon on
hover; people appear only as role plus initial; month-level dates carry a "month-level date" chip.

Each feature owns `src/features/<name>/` (component plus its own CSS file, imported by the component). Don't edit
the shell or data layer without saying so in your report; if you need a data helper, add it in your feature folder.
