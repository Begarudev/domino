# Run theatre (wow-mission)

A full-screen view of the agent at work: it reads sources, extracts signals, builds the cross-company chain, drafts a sourced message, waits at the approval gate, and then scores the replay. Kill-and-resume, a draggable credit cap and sent-once proof are built into the same view.

## Run it

```bash
bun install
bun run mission          # stand-alone harness → http://localhost:4330/
```

| URL | What it plays |
|---|---|
| `http://localhost:4330/` | Mock run of fictional companies (labelled **Fixture · synthetic data**). Press **Run**, then try **Kill engine**, drag the cap, and hold to approve. |
| `?autoplay=1` | Hands-free version for recording: kills the engine mid-cascade, approves, approves again, then runs the replay. |
| `?run=replay` | The 1 Sep → 22 Nov replay scoreboard on mock data. |
| `?sample=1` | `docs/sample-run-events.json`, a recorded **real** live run with names redacted, labelled **Cached live responses**. Read-only. |
| `?slot=1` | Renders at the app's 780×540 centrepiece slot size. |

Inside the real app (same backend, reducer and event stream):

- `bun run dev:web`, then open `/?view=theatre`. Add `&mock=1&autostart=1` to run without a server. The theatre wires Kill, Resume, the credit cap and Approve to the real endpoints.
- `/?centre=mission` mounts the same component in the classic layout's centrepiece slot. It is registered in `web/src/centrepiece/registry.ts`.

## What is real and what is a fixture

- The view invents nothing. Every card, chip, tile, stamp and number comes from a `StoredEvent` or the `RunSnapshot`:
  - source cards come from `source.read` items, or from `evidence.added` rows when the engine sends no `source.read`;
  - signals come from `trigger.found`;
  - tiles come from `graph.edge`, `graph.node` and `evidence`;
  - the draft comes from `draft.checks`;
  - the receipt comes from `action.executed`, `action.duplicate_blocked` and `outbox`;
  - the scoreboard comes from `replay.scored`.
- The harness mock (`web/src/mock/events.ts`) uses fictional companies and is labelled as a fixture. Its replay numbers are fixture numbers, and the scoreboard says so.
- `?sample=1` plays events recorded from a real live run.

## Files

- `web/src/centrepiece/mission/`: the module. `model.ts` derives everything from the event log. `Desk`, `Chain`, `Gate`, `Scoreboard` and `Instruments` render it, and `mission.css` holds the styles. The fonts (Big Shoulders Display, Hanken Grotesk, IBM Plex Mono) are bundled for offline use.
- `web/src/theatre/Theatre.tsx`: the full-screen route in the real app.
- `web/mission/`: the stand-alone harness, including `sampleRun.ts`, which plays the recorded real run.
- `wow/wow-mission/shoot.mjs`: Playwright script that captures every key state. The screenshots are saved next to it.
