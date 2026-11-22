# Talent flow (centrepiece `flow`)

A time-lapse of job moves between AI companies that shows DOMINO's rule O1 at work: people leave, no replacement is posted, DOMINO predicts the opening, and the later dated job post or hire proves it.

- Companies are lit nodes, sized by headcount. Every dated move flies from the old employer to the new one: amber for inference, ML platform, MLOps and GPU roles; pale for other roles; frost for moves after the freeze, which are not used.
- Rule O1: when a company loses 2 or more people in one role family within 90 days and posts no replacement, the trail becomes a river and the company cracks. A rose ring reads "Predicted opening: <role>", with "N departures · no replacement posted" under it. Pairs that fall below the rule, or where a replacement was posted, stay a thin line with the reason.
- At 1 Sep a frost line sweeps across the field and the predictions lock (dashed cyan). The job-post filter's picks show as dotted slate rings.
- Playing forward, each dated job post or hire lands on its company: the ring turns solid, an outcome chip appears beside it, and the score ticks. The score panel reads "Which predicted openings were later posted or filled?". It compares DOMINO with the job-post filter (any job post in the last 30 days), and the headcount +30% filter appears in a footnote.
- A confidence percentage appears only when it comes from the engine (`node.confidence` on non-fixture data). On fixture data the line shows the evidence count instead.
- The drafted-message finale is off by default, because the v2 desk owns outreach. To bring it back, pass `<TalentFlow withLetter />`.

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

Keys: Space plays or pauses, R restarts, F jumps to the end, and the arrow keys step one second. Drag the timeline to scrub.

## Data

The view is driven only by `RunSnapshot`, through `CentrepieceProps`:

| Visual | Source in `RunSnapshot` |
|---|---|
| Moves | `triggers` of kind `hire` or `departure` that have a `relatedCompanyId`; one particle per dated `/person/search` evidence row. Title regex `SERVING_RE` marks serving roles. |
| Rivers (O1) | 2 or more role-family departures in 90 days from a company that has a `TALENT_DRAIN` graph node with a `need`; with no graph, the count alone. A `job_post` trigger for the family within 30 days marks a pair as replaced. |
| Predicted-opening rings | Graph nodes with `need` (the role) and a cross-company mechanism; dots count evidence rows. `unverifiable` nodes read 'Not yet'. |
| Predictions and score | `replay.outcomes` and `replay.domino`, `baselineFirstOrder`, `baselineHeadcount`, `factsAfterAsOfUsed`, `snapshotLabel` |
| Letter (only with `withLetter`) | The top non-held target's draft (`checks`, `citations`, `unverifiable`). With no draft (replay runs), it shows "Why DOMINO called X" from the node's dated evidence. |

While `running` is true, the view holds at the start. It plays from 0 when the run finishes. `replayToken` restarts it. `reducedMotion` jumps to the end state.

`fixture.ts` is a labelled synthetic replay of fictional companies: the same world as `web/src/mock`, plus bystander companies and their ordinary moves. Every row has `mode: 'fixture'`, and the view shows "Fixture · synthetic companies and people". `engine-*.json` are snapshots recorded from the real engine with `DOMINO_DATA=fixture`, so they are synthetic too.

## Screenshots

`bun run wow:flow`, then:

```bash
PW=<path to playwright-core> node wow/wow-flow/shoot.mjs
```

The env vars `SHOTS`, `EXTRA`, `VW`/`VH`, `VIDEO` and `FPS` are described in the file. `wow-flow-playthrough.mp4` is a 33-second headless recording. Headless Chromium measured 60 fps.
