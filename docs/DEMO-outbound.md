# DOMINO demo: 2-minute script and video shot list

Setup before recording: `npm run demo`, browser at 1440x900, zoom 100%, a fresh run list. Data badge must read what is
true (Live Crustdata / Cached live responses from <time> / Fixture). Keep the cost ledger tab one click away.

## Script (2:00)

| Time | Say | Show |
|---|---|---|
| 0:00-0:10 | "SDR agencies are paid per meeting with the right buyer. They all watch one trigger: hiring. DOMINO finds the buyer whose need someone *else's* move created." | Empty table, request bar |
| 0:10-0:30 | "A real request: we sell managed GPU inference, find who needs it after the last 30 days, book meetings with who decides." | Type/paste request, Run. Budget meters tick; one Crustdata call times out and is retried in the timeline; namesake merge line appears |
| 0:30-0:55 | "Kestrel Labs hired three serving engineers from Orbital Voice in the last four weeks. Kestrel is what every hiring filter sees. Orbital is the second domino: it just lost the people who run its inference, so it buys instead of rebuilding." | The cascade tips: Kestrel, then Orbital, Tessera (displacement), Nimbus/Quill (contagion). Click the Orbital edge: dated evidence rows, source field, "could also mean" line |
| 0:55-1:10 | "Toggle the hiring filter: everything dimmed is what a normal tool would miss." | Hiring-filter view on; net-new stamps |
| 1:10-1:35 | "One decider per account, from public work history. The draft only states what a dated source says; hover any [n] to see it. This claim had no date, so DOMINO says it can't verify it and leaves it out." | Drafts tab: decider card, citation hover lights the drawer row, "I can't verify" list, "Removed by verifier" |
| 1:35-1:50 | "A person approves. It goes once to our test inbox. Approve again: already sent, not sent again. Kill the engine mid-run and resume: it picks up at the checkpoint and repeats no calls." | Approve, duplicate blocked; crash + resume lines in timeline; ledger totals |
| 1:50-2:00 | "And we checked ourselves: frozen at 1 September with zero later facts, DOMINO's picks against the hiring filter, scored on what actually happened by today." | Replay score tab: scoreboard (real numbers, even if DOMINO loses) |

## Shot list (video)

1. Title card (2 s): "DOMINO: the Outbound Desk that finds the second domino".
2. Request typed, Run pressed (close crop on request bar and meters).
3. Timeline: injected timeout + retry, merge, kept-apart (zoom on left column).
4. Cascade animation full frame (the money shot), then edge click and the evidence drawer.
5. Hiring-filter toggle on/off.
6. Drafts tab: citation hover, can't-verify list.
7. Approve, then approve again (duplicate blocked toast).
8. Crash engine, Resume (timeline red rule, "reused from checkpoint").
9. Cost ledger tab with totals (credits, tokens, USD).
10. Replay score reveal.
11. End card: repo URL, "every claim traces to a dated source".

## Q&A prep (1:00 live)

- *Isn't this Avina/Coldreach?* They sell first-order hiring signals (X hires, so X buys). Our rules are cross-company and
  we show the replay against that exact baseline.
- *How do you know the prediction is right?* We don't claim purchases. Replay from 1 Sep scores whether the company
  *showed* the need (dated infra hire or post) later; numbers are on screen, including misses.
- *Hardest case?* A "talent drain" that isn't: late profile updates, internal transfers between a parent and subsidiary,
  namesakes. Guards: 30-day profile lag in replay, domain-root check, merge only on id/domain, >= 2 dated rows per rule.
- *Who could it get wrong?* A company whose engineers left for a re-org or a sabbatical; we show the competing
  explanation on every edge and a person approves every message.
- *Personal data?* One decision-maker per account, public work history only, no emails/phones, movers as counts.
- *What's next?* Crustdata watchers instead of polling, rule confidence learned from replay, outcome tracking.
