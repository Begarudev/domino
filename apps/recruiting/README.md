# DOMINO recruiting backend

The frontend uses the typed Convex API in `convex/_generated/api`. The demo script and acceptance criteria live in [DEMO.md](../../docs/DEMO.md) and [BUILD_PLAN.md](../../docs/BUILD_PLAN.md).

## Start the local backend

Run from `apps/recruiting`, with Bun and Node 22.13 or later.

```sh
bun install --frozen-lockfile
CONVEX_AGENT_MODE=anonymous bun run convex:dev
```

In a second terminal, seed the demo and verify it.

```sh
bun run demo:setup
bun run typecheck
bun run test
bun run test:local
bun run build
```

`demo:setup` puts signed eight-hour test tokens in the ignored `.env.demo`. Use a separate Convex client with the appropriate token for Rahul, Nova's recruiter, or Atlas's recruiter. The seed and acceptance commands target a local deployment. The acceptance test resets the fixture before and after the run. For a real sign-in flow, configure `CLERK_JWT_ISSUER_DOMAIN` on Convex and use the authenticated frontend session. The deployment administrator registers verified recruiter accounts with `market:registerRecruiter`.

The Next.js integration route `GET /api/health` checks the backend configured by `NEXT_PUBLIC_CONVEX_URL`. The frontend owns the screens.

## Frontend calls

| Screen | Convex functions |
| --- | --- |
| Candidate onboarding | `profiles.saveProfile` takes name and LinkedIn URL, with optional work summary and a separate discoverability choice. Call `liveData.enrichProfile` with that candidate's consent for live LinkedIn enrichment. `profiles.profile` returns the saved profile and materials. |
| Optional materials | `materials.addLink` adds an HTTPS link. `uploads.addFile` accepts base64 PDF or text up to 2 MB. `materials.getMaterial` checks ownership or the introduction that shared it. |
| Introduction choices | `introductions.listIntroOptions` returns the supported role, company, recipient, and evidence. `introductions.previewIntro` supplies the confirmation token and shareable materials. Send with `introductions.confirmIntro`, passing that token, a stable request key, and the user's selected sharing fields. |
| Recruiter inbox | `introductions.recruiterCompanies` returns accessible teams. Subscribe to `introductions.recruiterInbox`; `introductions.markIntroOpened` updates the unread state. |
| Company dashboard | `companies.companyDashboard` returns comparison rows, a dated timeline, and coverage. `companies.getEvidence` resolves a cited record. `intelligence.classifyPosting` and `intelligence.summarizeComparison` provide additional model-assisted analysis. |

The intro is delivered when Convex commits it to the authorized recruiter's inbox. The same candidate-role pair returns the original receipt on retry. Live job postings become introduction options after a verified recruiter publishes the role with `market.publishRole`.

## Live provider configuration

Store provider values in the ignored local environment and run `bun run providers:local` to sync the configured values to local Convex.

| Configuration | API |
| --- | --- |
| `CRUSTDATA_API_KEY` | Crustdata `/person/enrich` for consented profile evidence and `/job/search`, `/company/enrich`, `/person/search` for market data. |
| `OPENAI_API_KEY` | OpenAI `POST /v1/decisions` with `gpt-6-luna`, for classifying public job text. |
| `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` | Vertex AI `generateContent` via Application Default Credentials. If needed, give the local runner the ADC file path in `GOOGLE_APPLICATION_CREDENTIALS`. `GEMINI_API_KEY` selects the Gemini API with key auth. |
| `VERTEX_FLASH_MODEL`, `VERTEX_NEON_MODEL` | Default to `gemini-3-flash-preview` for job classification and `gemini-4-neon` for market summaries. |

For live company data, the deployment administrator runs `liveData:refreshMarket` with the company and peer domains and a window. Job counts use the indexed date. Talent counts describe observed technical moves in sample work histories. A limited or failed collection marks coverage partial. The candidate profile, delivered intro, and recruiter membership stay in Convex.
