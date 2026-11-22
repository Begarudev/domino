# wow-physical: the domino table

The cascade as a literal 3D domino table. Every company is a tile with its name and key number on its face, and real
rigid-body physics (three.js, react-three-fiber, Rapier) runs the chain from the trigger companies to the companies
DOMINO predicts will buy.

## Run it

```bash
bun install
bun run wow:physical          # standalone harness: http://localhost:4410/wow-physical.html
bun run dev:web               # inside the app: http://localhost:5173/?centre=physical  (add &mock=1&scenario=replay for the recorded replay)
```

Harness query options: `mode=replay|live`, `size=full|slot` (slot = 780x540), `autoplay=1`, `filter=1`
(hiring-filter view), `rm=1` (reduced motion).

## What happens

1. **Frozen at the as-of date.** The clock shows 1 Sep 2026 and the hero asks the buying question
   ("Who will need managed GPU inference?"). The caption reads "Predictions use 0 facts dated after 1 Sep"
   (from `replay.factsAfterAsOfUsed`). Zone labels name the trigger column, the predicted buyers and the back row
   of hiring-filter picks.
2. **Predict.** Play tips the trigger tiles. Each falls into its lanes of small dominoes, one lane per graph edge,
   and the chain runs until it leans on the predicted company. That company glows amber and keeps standing, held by its pin.
   Slips over each tile show only evidence dated before the freeze ("Trigger known 19 Aug 2026").
3. **Replay.** The clock runs to 22 Nov. On a predicted company's real outcome date its pin is released. It falls
   under the weight of the chain, turns green, and an evidence slip lifts off it with the date, endpoint, field and
   data mode. Time slows while a tile falls. Misses never fall: at the end they turn grey, still holding their
   chain. The hiring filter's picks in the back row fall on their own job posts, with no chain.
4. **Score.** The camera pulls back to the whole table. The score column shows DOMINO's picks with a dated signal
   against the hiring filter's, and how many of DOMINO's hits the filter never returned. Numbers come from
   `snapshot.replay`.

For a live run (no `replay` block), the chain runs and the predicted tiles fall as amber hypotheses.

Clicking a tile calls `onSelect({kind:'node', id})` and clicking a connector calls `onSelect({kind:'edge', id})`,
so the app's evidence drawer opens.

## Data

- `fixture.ts` holds labelled synthetic fixtures with fictional companies in the build lead's fixture world. The
  HUD badge reads "Fixture data, fictional companies" whenever `snapshot.dataMode === 'fixture'`.
- Inside the app the component reads the app's own `RunSnapshot` (mock, cache or live) and labels the mode.
- The component never invents numbers. Tiles, lanes, outcomes, dates, sources and the score all come from
  `graph`, `evidence`, `replay` and `baseline`.

## Files

| File | What it does |
|---|---|
| `web/src/centrepiece/physical/index.tsx` | `physicalModule` (CentrepieceModule) and the HUD (clock, question, tally, score, timeline) |
| `web/src/centrepiece/physical/Scene.tsx` | physics world, tiles, spacer lanes, director (phases, release, camera), slips, post effects |
| `web/src/centrepiece/physical/layout.ts` | pure RunSnapshot to table layout (positions, lanes, baseline row) |
| `web/src/centrepiece/physical/faces.ts` | etched tile faces drawn to canvas (colour, bump and glow maps) |
| `web/src/centrepiece/physical/fixture.ts` | labelled fixture snapshots (replay and live) |
| `web/src/centrepiece/physical/dev.tsx`, `web/wow-physical.html`, `web/wow-physical.vite.config.ts` | standalone harness |
| `wow/wow-physical/shoot.mjs` | Playwright screenshot harness (`PW_EXE` = a Chromium binary; Metal ANGLE gives 60 fps headless) |
