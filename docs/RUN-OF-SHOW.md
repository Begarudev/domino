# DOMINO · Run of show (current walkthrough)

DOMINO predicts what a company needs next from the domino effects between companies, and helps it act: hire the right
people and reach the right buyers, with proof. This walkthrough follows the app as built at `freeze-1645`. The earlier
scripts (`DEMO.md`, `DEMO-outbound.md`) are drafts from before the final screens.

## Before recording (run once, right before)

```sh
cd ~/dev/domino-wt/serve && DOMINO_DB=/Users/garudev/dev/domino/data/domino.db bun run demo:reset-intros --reopen --crash-after-deliver
```

This archives the demo candidate's earlier intros (nothing is deleted) and drafts a fresh one awaiting approval.
Approving it delivers once, then deliberately crashes the delivery process, so the resume beat is real. It costs 0
Crustdata credits. Run it again if the intro gets used up in a take.

Already on the server (`:4321`), nothing to prepare:

- **Openings scan:** a replay of the live Crustdata read of 22 Nov, 14:30–14:34 IST, at 0 new credits.
- **Live Find buyers run:** `run_1a165a3d`, 22 Nov 16:19 IST, 142.0 credits.
- **Scored 1 Sep replay:** `run_c352184a`, 0 credits.
- **Blocked-before-spend row:** `run_2a38d6d8`.

## Run of show

### 0:00–0:20 · A candidate gets openings before they are posted

**Show:**
1. Sign in → Candidate. Paste the labelled demo profile URL and tick the consent boxes.
2. The parsed profile appears ("Parsed by GPT-6 Luna"). Confirm.
3. **Openings for you:** Abacus.AI, ML platform, *provisional*, window closes 30 Nov. Each clause is a chip.
4. Request intro. The preview shows what is shared and what is withheld.

**Say:** "Two ML platform engineers left Abacus.AI in October. No replacement post or hire since. DOMINO predicts the
opening before it is posted, and the candidate decides what to share."

### 0:20–0:35 · The company sees who left and who it can hire

**Show:**
1. Company → Abacus.AI → **Hire**. Departures appear as role + initial + month. The August move is struck through,
   because its month straddles the window start.
2. The funnel: 1,410 → 312 → 250 → 95 → 3 → **1 provisional, 2 held**.
3. "Why this target?" gives the ranking rules with no score. Below it, people you can hire, with field-by-field fit.

**Say:** "Every step of the funnel is a rule, not a score. Two companies were held by false-drain guards: an acqui-hire,
and a month that can't be settled."

### 0:35–2:20 · How DOMINO works (one beat per tab)

| Tab | Show | Say |
|---|---|---|
| **Read → Reading log** | Every record the scan read, kept or discarded with its reason | "Nothing is hidden: here is what it read and why it dropped the rest." |
| **Read → Company file** | Dated facts, headcount 271 → 288 (+3.6% over 90 days), talent flows, rule rows O1 · R1 · CONTAGION · DISPLACEMENT | "No generated prose. Every line is a dated fact." |
| **Read → Chains** | The rules registry: statements, lock times, today's fire counts. R1 fired 0; its threshold stayed at 3 | "We fixed thresholds before looking, and kept them when the count was zero." |
| **Act → Find buyers** | Live run `run_1a165a3d`: EWOR drafted from 2 verified live facts, sent to the CTO role. Crusoe, Nscale and one more are "Not drafted (0 of 2)", and The Royal is "(1 of 2)" | "Five predicted needs on real companies. Only one had enough verified evidence to write to. The rest are held back, and it says why." |
| **Read → Verifier** | Each claim against its dated source, or "I can't verify" | "If it can't verify a sentence, the sentence doesn't go out." |
| **Act → Outreach** | The fresh demo intro: footnotes [1] [2]… each open their dated row. Approve → "Delivery process stopped after the test inbox accepted (deliberate crash test)" → Resume → "Already delivered · skipped · Deliveries: 1" | "Approve once, send once, even through a crash." |
| **Check → Replay** | As of 1 Sep: O1 0 predicted (6 held); any job post 57 picks, 6 hits; headcount +30% 0; base rate 6 of 91. "Not a point-in-time index" | "On 1 Sep our rule made no prediction, so it can't beat a baseline here. We show that anyway." |
| **Check → Ledger** | Every paid call against its cap. The Find buyers run cost 142.0 credits; the openings scan 0. One row reads "Blocked before spend · cap credits 0 · would have cost ≈ 2.4 credits" | "The cap stops a call before it spends, not after." |

### 2:20–2:30 · Close

**Say:** "DOMINO predicts the next domino, and helps you move first, with every claim dated."

## Live vs cached (say it if asked; the screens already label it)

- **Openings scan:** live Crustdata read, 22 Nov 2026, 13:50–14:40 IST. The demo replays it from the recorded cache
  for 0 credits; the run chip says so.
- **Find buyers:** a fresh live run at 16:19 IST, 142.0 credits.
- **Replay:** today's index filtered to facts dated on or before 1 Sep. Not a point-in-time snapshot.
- **No sends:** all messages go to the team test inbox only. Nothing is sent to a real person.
- **Pre-fix run:** `run_88e2d6ec` (13:09 IST) predates the fix that stopped live runs falling back to fixtures. The server
  labels it "Not live results". Don't use it.
