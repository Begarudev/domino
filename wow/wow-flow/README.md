# Talent flow (centrepiece `flow`)

A time-lapse of job moves between AI companies, played from the replay's start to its end.

- Companies are lit nodes, sized by headcount. Every dated move flies between them, from the old employer to the new one: amber for serving and inference roles, pale for other roles, frost for moves after the freeze, which are not used.
- When one company takes 3 or more of another's serving engineers within 90 days, the trail becomes a river. The losing company cracks, sheds shards and shrinks. A rose ring blooms around it with the inferred need and one dot for each dated evidence row (hollow dots are undated).
- At the freeze date, a frost line sweeps across the field and stops the clock. Particles still in the air hang in place. DOMINO's predictions drop in as dashed cyan halos; the hiring filter's picks show as dotted slate halos.
- Playing forward, each dated outcome falls onto its company. The halo snaps solid and the score ticks: DOMINO against the hiring filter. A miss stays dashed with "no dated sign yet".
- Finale: the camera zooms in on the top account. The first message assembles itself: each cited sentence flies out of its evidence bead with a source chip (`[n] date · endpoint · field · mode`). The verifier's removed sentence is struck through. "I can't verify" items stay out of the message, and the approval gate is stated.

## Run it

```bash
bun install
bun run wow:flow          # http://localhost:5181/
```

Inside the app: `bun run dev:web` with `?centre=flow` (for example `/?mock=1&scenario=replay&centre=flow`).

Standalone query flags:

| Flag | What it does |
|---|---|
| `?slot=1` | Renders at the app's 780x540 slot size |
| `?s=12.5` | Starts paused at that story second |
| `?filter=1` | Hiring-filter view |
| `?data=engine` | Uses a real replay snapshot recorded from the engine |
| `?data=engine-live` | Uses a real live-run snapshot recorded from the engine |
| `?speed=` | Sets the playback speed |

Keys: Space plays or pauses, R restarts, F jumps to the finale, and the arrow keys step one second. Drag the timeline to scrub.

## Data

The view is driven only by `RunSnapshot`, through `CentrepieceProps`:

| Visual | Source in `RunSnapshot` |
|---|---|
| Moves | `triggers` of kind `hire` or `departure` that have a `relatedCompanyId`; one particle per dated `/person/search` evidence row. Title regex `SERVING_RE` marks serving roles. |
| Rivers | 3 or more serving moves in 90 days, or a `TALENT_DRAIN` graph edge |
| Need rings | Graph nodes with a cross-company mechanism; dots count their evidence rows |
| Predictions and score | `replay.outcomes` and `replay.domino`, `baselineFirstOrder`, `baselineHeadcount`, `factsAfterAsOfUsed`, `snapshotLabel` |
| Letter | The top non-held target's draft (`checks`, `citations`, `unverifiable`). With no draft (replay runs), it shows "Why DOMINO called X" from the node's dated evidence. |

While `running` is true, the view holds at the start. It plays from 0 when the run finishes. `replayToken` restarts it. `reducedMotion` jumps to the end state.

`fixture.ts` is a labelled synthetic replay of fictional companies: the same world as `web/src/mock`, plus bystander companies and their ordinary moves. Every row has `mode: 'fixture'`, and the view shows "Fixture · synthetic companies and people". `engine-*.json` are snapshots recorded from the real engine with `DOMINO_DATA=fixture`, so they are synthetic too.

## Screenshots

`bun run wow:flow`, then:

```bash
PW=<path to playwright-core> node wow/wow-flow/shoot.mjs
```

The env vars `SHOTS`, `EXTRA`, `VW`/`VH`, `VIDEO` and `FPS` are described in the file. `wow-flow-playthrough.mp4` is a 35-second headless recording. Headless Chromium measured 60 fps.
