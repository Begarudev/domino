# DOMINO recruiting build plan

This file owns the work split, shared interfaces, and integration criteria. Read [DEMO.md](DEMO.md#run-of-show) for the sequence the build must support.

## Target

Ship a Next.js and Convex app that runs the recruiting demo end to end. Rahul enters his name and LinkedIn URL, with optional work samples. He chooses a company introduction and confirms what to share. Nova's recruiter receives it alongside suggested candidates. Nova's company dashboard compares hiring, headcount, funding, and talent movement with Atlas and a third peer, with dated evidence behind the comparison.

Build the recruiting app in `apps/recruiting/`. The earlier [Outbound Desk contract](CONTRACT.md) covers the Hono and SQLite implementation. This plan governs the recruiting app. Reuse the existing Crustdata and evidence logic where its inputs and outputs fit.

## Kickoff

1. **Integration lead** creates the integration branch, sets up the Next.js and Convex workspace, and commits the shared types, fixture, and commands for running, seeding, and testing the app. Every workstream branches from this same commit.
2. **Repository maintainer** enables GitHub Discussions. The integration lead opens the coordination discussion and records its link here. Discussions setup is pending.
3. **Workstream leads** take separate worktrees and target their PRs at the integration branch. A lead can delegate work within their assigned area and remains responsible for assembling, validating, and handing off their changes.

## Ownership

| Owner | Files and deliverables | Ready when |
| --- | --- | --- |
| **Design and frontend** | `apps/recruiting/app/` and `apps/recruiting/components/`. Own the design and runnable Next.js screens for candidate onboarding, intro recommendations and confirmation, the recruiter inbox, and the company dashboard. Build against the shared fixture and typed interfaces, then connect the screens to Convex. | All demo screens run at presentation size. The recruiter view makes **New intro** and **Suggested** visually distinct. The company dashboard can open the dated source behind a peer comparison. |
| **Backend** | `apps/recruiting/convex/`. Own the schema, access checks, profile and recommendation queries, intro delivery, recruiter inbox, and company dashboard read models. Own Crustdata normalization and model adapters. A backend lead can delegate ingestion and company intelligence as independent work. | A seeded candidate can send an intro to the verified recruiter account once. The authorized recruiter can read it alongside suggestions. Company and peer data point to dated evidence. Backend tests cover those behaviors and cross-company access. |
| **QA** | `apps/recruiting/tests/e2e/`. Own the automated acceptance flow, test data setup, regression cases, and recording check. Start with the contract and fixture, then run the tests against the integrated app with distinct candidate and recruiter sessions. | A fresh seeded run passes the full demo path and the failure cases below. Record the tested commit and the commands and results. |
| **Integration lead** | Own `apps/recruiting/shared/`, `apps/recruiting/fixtures/`, package and environment setup, this plan, and the integration branch. Resolve contract changes, land the workstream PRs, and run the final acceptance and rehearsal. | A fresh checkout runs the documented setup, typecheck, tests, and production build. The integrated demo supports a 1:45 rehearsal. |

## Shared interface

The lead turns this table into typed interfaces and a fixture before the workstream split. Frontend and backend changes that affect an input, result, or state go through the coordination discussion and land in the shared contract first.

| Operation | Input and result |
| --- | --- |
| Save profile | Name and LinkedIn URL, plus optional résumé, portfolio, or work sample. Returns the candidate's profile ID and readiness state. |
| List intro options | Returns intro-ready companies for the signed-in candidate. Each option has a recommendation ID, company and role IDs, a reason, evidence references, and the recipient available in the demo. |
| Preview and confirm intro | Preview returns the recipient and the fields Rahul can share. Confirmation uses a stable request key and the approved fields. Validate the role and recipient server-side. Store one intro per candidate and role. A retry returns the existing record. |
| Read recruiter inbox | Returns delivered introductions and suggested candidates for the recruiter's company. Intro rows carry their role and delivery state. Suggestions carry their match evidence and retain their own status. |
| Read company dashboard | Returns the company overview, peer comparison for the selected time window, source coverage, and evidence references. A source opens by evidence ID. |

Use the same `companyId`, `roleId`, and `evidenceId` values throughout. Record delivery when the intro is durably visible to the receiving inbox. Authorize inbox reads against company membership and return only candidate fields shared for that purpose. Evidence records carry their source, event or observation date, and retrieval date. Show whether the data is live, cached, or fixture-backed.

### Shared fixture

Seed Rahul, an authorized Nova recruiter, another company account for access tests, several suggested candidates, intro-ready companies, and Nova's inference role. Seed Nova, Atlas, and a third peer with hiring, headcount, funding, and talent data, including a dated source for a meaningful hiring difference. Start every run with Rahul's intro absent. Provide a repeatable reset for this demo workspace so both development and CI can replay the same scenario.

### Data and models

Convex owns app state and the recipient handoff. Crustdata supplies company, jobs, and talent signals. Candidate-submitted materials and company membership supply sharing and routing state. Use a deterministic fixture path for integration. Gemini Flash can extract structured profile and role evidence. Evaluate OpenAI Decisions for ambiguous role classification and Gemini Neon for background company summaries after the core flow passes. Confirming an intro uses the stored job, authorized recipient, and candidate approval.

## Coordination and integration

Use GitHub Discussions for agent questions, blockers, decisions, and handoffs. Include the affected interface or file, the requested decision, and any relevant PR. Record accepted scope and contract changes in this file or the shared interface it points to. At handoff, post the PR and commit, what works, exact verification commands and results, and open risks.

1. Land the scaffold, shared contract, and fixture.
2. Build frontend and backend concurrently. QA prepares the acceptance tests against the same fixture.
3. Integrate the backend and connect the frontend to the real Convex operations. Run the full suite and fix failures on the integration branch.
4. QA runs the final acceptance checks on the integrated commit. The integration lead rehearses [the demo](DEMO.md#run-of-show) on that commit and advances the build when it passes.

## Acceptance

- Rahul completes onboarding and sees several intro options with relevant evidence. He selects Nova and confirms the recipient and materials.
- Nova's recruiter sees Rahul arrive without a manual reload and opens the intro beside several separately labeled suggestions. A repeat submission or reload produces exactly one delivered intro.
- A recruiter from another company cannot read Rahul's intro. An invalid or unavailable recipient cannot produce a delivered record.
- Nova's dashboard compares it with Atlas and a third peer. The peer comparison shows its time window and opens a dated record supporting the displayed finding.
- The seeded path runs with external providers unavailable and shows its fixture label. QA records the end-to-end result against the integrated app, then the team rehearses to 1:45 with 15 seconds of buffer.
