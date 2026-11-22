# Live data (22 Nov 2026)

Every number on this page comes from live Crustdata reads made on 22 Nov 2026 between 13:50 and 14:40 IST. Each
response was cached with its retrieval time and is labelled **live-cached**. Redacted snapshots are committed under
`docs/live/`. Raw person pages stay out of git: people appear only as role, first initial and month. No names,
person IDs or profile URLs are committed. R1's threshold was fixed before its count. O1 was fixed at 14:08 IST, after seeing the live departure counts and
before looking at any replay outcomes, and its month-interval semantics were fixed at 14:14 IST, also before any replay
outcome was read.

## Sources and filters (checked against docs.crustdata.com)

| Source | Endpoint | Filters used | Notes |
|---|---|---|---|
| Talent drain (live) | `POST /person/search` | `experience.employment_details.current.start_date` `=>` 2026-08-24 AND phrase-OR (`[.]`) on `experience.employment_details.past.title` over {inference, serving, ML platform, ML infrastructure, MLOps, GPU, LLM infrastructure, AI infrastructure, ML systems, machine learning platform, machine learning infrastructure, model deployment}; `limit` 200, cursor pages | 1,410 of 1,410 profiles (8 pages). Person search returns 429 after about 4 calls a minute; pages were spaced 20 s apart with a 60 s back-off on 429. |
| Talent drain (1 Sep replay) | `POST /person/search` | same title OR, `current.start_date` in (2026-05-04, 2026-08-02], i.e. (asOf − 120 d, asOf − 30 d] | 2,456 of 2,456 profiles (13 pages). The 30-day profile lag means a move counts only if its new start month ended by 2 Aug. |
| No replacement posted | `POST /job/search` | `company.basic_info.company_id` `=` A, `metadata.date_added` `=>` start of the last departure month and `<` 2026-11-23, phrase-OR on `job_details.title` for the role family | A second read with no title filter counts all of A's posts. |
| No replacement hired | `POST /person/search` | `experience.employment_details.current.company_id` `=` A, `current.start_date` `=>` start of the last departure month, phrase-OR on `current.title` for the role family | |
| Reading news | `POST /web/search/live`, `sources: ["news"]`, `start_date`/`end_date` as Unix seconds | free-text query, e.g. `Poolside NVIDIA inference team` | Results have no publication date. The date comes from the article page's `article:published_time` / JSON-LD `datePublished`, read with Crustdata Web Fetch (branch `livedata-news`) or directly. A result without a readable date is labelled an undated lead and is never used as a fact. |
| Headcount baseline | `POST /company/enrich` | `crustdata_company_ids`, `fields: ["basic_info","headcount"]` | Headcount as of 1 Sep = latest `headcount.timeseries` point on or before 1 Sep; monthly growth against the point 28–35 days earlier. |
| Social posts | `POST /social_post/search` | `text` `[.]` phrase, `date_posted` `=>` | **Gap:** the indexed post dataset ends at 17 Sep 2026 (for example, "inference" since 1 Nov returns 0, and "Hugging Face" returns posts only up to 17 Sep). That's why earlier runs saw empty posts. Not used for live decisions. |

## Talent-drain funnel, live (supersedes the 1,200-profile partial count in docs/YIELD.md)

| Step | Count |
|---|---|
| People with an infra/serving past title and a new role since 24 Aug | **1,410** (all fetched) |
| Direct moves (previous role ended ≤ 60 days before the new one) | 770 |
| …previous role itself infra/serving (hardware design and non-engineering titles excluded) | 289 |
| …previous employer ≤ 5,000 staff | 151 |
| Distinct losing companies | 148 |
| Companies with ≥ 2 such departures | 3 (Poolside, Abacus.AI, Multiverse Computing) |
| Companies with ≥ 3 to one hirer in the window, 3rd in the last 30 days (old R1) | **0** |

## Rule O1 in the engine (openings pipeline)

`POST /api/openings/scan` runs scope_search → pull_departures → resolve_departures → check_replacements →
detect_openings (→ score_openings in replay). Every read is a cached `source.read` with a ledger row.

| Run | Mode | Credits | Time | Result |
|---|---|---|---|---|
| `run_0c071dae-52fa-48bb-bdb5-989bf3f87203` | live | 339.3 | 224 s | 1 open (provisional), 2 held, 88 watch |
| `run_12852b1c-6483-4efc-ae53-c109b221217c` | cache (the live responses above) | 0 | 0.4 s | identical |

Engine funnel (`detect_openings.output.funnel`; each stage opens its rows, people shown as role + initial + month):
1,410 profiles → 312 direct moves out of a tracked-family engineering role → 250 with the departure month inside or
straddling the 90-day window → 95 at 20–5,000 staff → 3 company × family groups with ≥ 2 → **1 provisional opening,
2 held**. The engine counts each (person, past role) once and classifies titles with `roleFamily()`, so its counts are
a little higher than the offline script's 281/176 below. The decisions are the same.

- **Abacus.AI · ML platform · provisional.** ✓ 2 conclusive departures (Oct, Oct) · ✓ no acquisition report naming Patronus AI, Arcfront or Bravebird · ✓ 288 staff · ✓ headcount +3.6% over 90 days · ✓ job search 1 Oct–22 Nov: 0 records · ✓ person search: 0 · ⏳ window closes by 30 Nov.
- **Poolside · inference · held.** ✓ 2 conclusive departures (Sep, Sep) → NVIDIA · ✗ acqui-hire guard: "Nvidia pays Poolside $6bn to license its model factory and hire 109 staff" (thenextweb.com, 21 Aug 2026), plus a Quartz report from 24 Aug, both found live through Crustdata Web Search and dated from the article pages, with no analyst entry · ✗ restructure guard: headcount −13.2% over 90 days. The news report is company-level and doesn't verify either person's move.
- **SANI · ML platform · held.** Month-only dates can't settle the window.

## Rule O1, live

O1 (rule fixed at 14:08 IST, after seeing the live departure counts and before looking at any replay outcomes): at company A (20–5,000 staff), if there are ≥ 2 conclusive dated departures in role family F
within 90 days, and no dated replacement hire or job post for F at A within 30 days of the last departure, then
predict an opening for F at A. False-drain guards (acquisition or acqui-hire, shared parent, > 40% of headcount, an
ambiguous company ID, month-only dates that can't settle the window, unrecognised titles) send a candidate to Hold.

Crustdata role dates are month precision: every one of the 28,666 role dates in the live pull falls on the 1st. A
month counts as conclusive only when the whole month sits inside the window. When the no-replacement window hasn't
closed yet and nothing has appeared so far, the prediction is **provisional**.

| Step | Count |
|---|---|
| Profiles | 1,410 |
| Family departures (engineering title in inference / ML platform / MLOps / GPU-LLM infra, direct move) | 281 |
| …conclusive inside the 90-day window | 176 |
| Company × family groups | 238 (103 at 20–5,000 staff) |
| Groups at 20–5,000 staff with ≥ 2 departures | 4 |
| …with ≥ 2 conclusive | 2 |
| Predicted openings | **1, provisional** |
| Hold | **1** |

**Predicted opening (provisional): Abacus.AI (288 staff), ML platform.**
- P., ML Platform Engineer, left Oct 2026 → Arcfront (started Oct 2026).
- P., ML Platform Engineer, left Oct 2026 → Bravebird (started Nov 2026).
- A third, Y., Machine Learning Platform Engineer, left Aug 2026 → Patronus AI (Sep 2026). August straddles the window start, so it isn't conclusive.
- No replacement: job search for Abacus.AI (company_id 632052) ML-platform/infra/MLOps titles from 1 Oct to 22 Nov returned 0. Person search for an ML-platform hire starting since 1 Oct returned 0. Checked 22 Nov 2026. Abacus's only posts since 1 Oct are six "Forward Deployed Engineer – AI Agentic Platform" listings (5–17 Nov), which are outside the family. The replacement window closes by 30 Nov.

**Hold: Poolside (302 staff), inference.**
- L. and A., both "Member of Engineering (Inference)", left Sep 2026 → NVIDIA.
- No inference posts or hires since 1 Sep. Crustdata also lists 0 Poolside job posts of any kind since 1 Sep, so this may be a coverage gap.
- Acqui-hire guard: Crustdata news search for "Poolside NVIDIA" returns "Nvidia pays Poolside $6bn to license its model factory and hire 109 staff" (https://thenextweb.com/news/nvidia-poolside-6bn-model-factory-licence, `article:published_time` 2026-08-21). The departures are an acqui-hire, not a drain.

Also held: SANI (34 staff, ML platform; the August month-only dates can't settle the window). Multiverse Computing's departures ended in July, outside the 90 days. Every other group with ≥ 2 departures is above 5,000 staff (Intel, Google, Meta, Microsoft, Oracle, Qualcomm, AWS, Apple, Optum, TikTok).

## 1 Sep replay

Snapshot: **live-cached**, retrieved 22 Nov 2026 14:08–14:17 IST. Frozen at 1 Sep 2026. **0 facts dated after 1 Sep**
were used for any prediction. Departures had to be on profiles by 2 Aug (the 30-day lag), and pre-cutoff job posts
had to be dated on or before 1 Sep. Outcome, the same for every arm: a dated job post or hire whose title is in an
infra/serving role family (inference, ML platform/infra, MLOps, GPU/LLM infra) at the company in (1 Sep, 31 Oct].
O1 is scored on its own family F. Raw counts only:

| Arm | Picks | Picks with an outcome by 31 Oct |
|---|---|---|
| O1 (≥ 2 conclusive family departures in 90 days, no replacement) | **0** predicted (0 provisional), 1 Hold | 0 |
| Baseline: any job post in the last 30 days (2 Aug–1 Sep) | 70 | 10 |
| Baseline: headcount +30% (monthly, enrich timeseries as of 1 Sep) | 0 | 0 |
| All companies in the cohort (20–5,000 staff on 1 Sep, ≥ 1 family departure) | 118 | 10 |

Universe: 2,456 profiles → 241 companies with a family departure → 118 at 20–5,000 staff on 1 Sep (enrich timeseries).
The Hold is Clarifai (46 staff, MLOps): 3 departures, but the June month-only dates straddle the window start. O1 did
not fire as of 1 Sep. With month-precision dates and the 30-day profile lag, only departures that ended in July can
be conclusive, and no company at 20–5,000 staff had two. The replay can't show O1 beating a baseline on this cohort,
and we say so. Files: `docs/live/replay-2026-09-01-summary.json`, `docs/live/o1-replay-2026-09-01.json`.

## 1 Sep replay in the engine (supersedes the offline replay table above)

Both runs were frozen at 1 Sep 2026. Snapshot label: "Live Crustdata read 2026-11-22, filtered to facts dated on or
before 2026-09-01; not a point-in-time index". **0 facts dated after 1 Sep** were used for any prediction
(`factsAfterAsOfUsed: 0`). Raw counts only.

**O1, `run_9b31dc6f-92f1-4b77-a787-e1e173c36bac`** (openings pipeline; 125 credits on top of the cached person pages from `run_f3226752`). Outcome: a dated job post or hire in the predicted role family at the company by 31 Oct.

| Arm | Picks | Picks with the outcome by 31 Oct |
|---|---|---|
| O1 | **0** (0 settled, 0 provisional), 6 held | 0 |
| Any job post in the last 30 days | 57 | 6 (median lead 6 days) |
| Headcount +30% (monthly) | 0 | 0 |
| Cohort base rate (20–5,000 staff on 1 Sep, ≥ 1 family departure) | 91 | 6 |

Funnel: 2,457 profiles → 399 direct moves (known by 2 Aug under the 30-day lag) → 234 in or straddling the window →
195 at 20–5,000 staff or unsized → 6 groups with ≥ 2 → 0 open, 6 held. Holds: Capital One, Clarifai and Control Plane
AI × 2 on month-only straddles, and Control Plane AI × 2 on unknown size, because Crustdata company enrich returned
HTTP 500 on 57 calls even after splitting batches down to single IDs. Two other groups passed every guard but
had replacements (41 family posts or hires between their last departure month and 1 Sep), so they correctly became
no opening. Run `run_f3226752` is **not reportable**: an enrich 500 left every company unsized, and the batch
split was added because of it.

**Company analysis (outbound pipeline), `run_1e80e15c-6d5b-4e57-9bd5-d94ee3929ea9`** (53.5 credits). Outcome: the
frozen 60-day serving/infra post or hire.

| Arm | Picks | Hits |
|---|---|---|
| DOMINO cross-company (DISPLACEMENT / CONTAGION / R1) | 2 (Mindrift, Ruby Labs; both DISPLACEMENT: named OpenRouter in a job post before Stripe agreed to acquire it, 19 Aug) | 0 |
| First-order (hiring filter) | 0 | 0 |
| Headcount +30% | 0 | 0 |

195 DISPLACEMENT edges came from OpenRouter mentions; CONTAGION produced 0 edges after domino-data's tightening; R1 0.

## Credits used (live Crustdata, this workstream)

| Read | Credits |
|---|---|
| Live departures pull, 8 pages / 1,410 profiles | 324.3 |
| Replay departures pull, 13 pages / 2,456 profiles | 564.9 |
| Replay scorer (10 company enrich, 3 job-search pages, 1 person search) | 534.3 |
| O1 no-replacement checks, news searches, job and post probes | 44.9 |
| Two end-to-end live app runs (run_f8a9cf1a, run_b42018fe; pre-pivot DISPLACEMENT run) | 85.5 |
| News worker probes (branch livedata-news) | ≈ 5 |
| O1 engine scans: live run_0c071dae (339.3), replay run_f3226752 (996.7, not reportable), replay run_9b31dc6f (125.1) | 1,461.1 |
| Outbound replay run_1e80e15c | 53.5 |
| **Total** | **≈ 3,074** |

Figures are summed from the `x-credits-used` header on each response.

## Known gaps

- Role dates are month precision only, so 30- and 90-day windows are settled by whole months. Some real drains wait in Hold, and some predictions stay provisional until the month closes.
- The social-post index ends at 17 Sep 2026, so it can't support live decisions.
- Web Search news results carry no date. Many come back as `google.com/goto` redirects that can't be fetched, and those stay undated leads.
- Job-post coverage is uneven: Crustdata lists no Poolside postings at all since 1 Sep.
- The replay cohort comes from today's profiles. A person who has moved again since then shows the later role as current and drops out of the replay query, so the replay undercounts departures.
- Headcount for the size filter in the live run is Crustdata's latest value. The replay uses the enrich timeseries as of 1 Sep.
