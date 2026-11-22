// The Search Desk API that v2 consumes. Types are the shared contract (shared/desk.ts, docs/CONTRACT.md
// "Search Desk" and "Company dossier"). Each call tries the live endpoint and falls back to the labelled fixture
// below only when the endpoint doesn't exist yet; every response says which one it came from.
import { API_ERROR } from '../../../shared/types.ts';
import type { Evidence } from '../../../shared/types.ts';
import type {
  Candidate, CompanyDossier, CompanySummary as SharedCompanySummary, CompanyView, Consent, Departure, FitReason,
  IntroRequest, Match, Opening as SharedOpening, OpeningForCandidate, OpeningReason, RoleFamily,
} from '../../../shared/desk.ts';

export type { Candidate, CompanyDossier, Consent, Departure, FitReason, IntroRequest, Match, OpeningReason, RoleFamily };
export { LINKEDIN_URL_MAX, ROLE_FAMILY_LABELS, SAMPLE_MAX_CHARS } from '../../../shared/desk.ts';

export type Provenance = 'live' | 'cache' | 'fixture' | 'sample';

/**
 * UI view of an opening. `windowClosesBy` marks a provisional prediction ("replacement window closes by 30 Nov"):
 * shown as "Predicted opening (provisional)" with a countdown chip. Held openings show "Held: <reason>".
 */
export type Opening = SharedOpening & { windowClosesBy?: string | null; fit?: FitReason[]; matchScore?: number };
export type CompanySummary = SharedCompanySummary & { held?: number };
export interface Funnel { label: string; count: number }
export type CompanyDesk = CompanyView & { funnel?: Funnel[]; checkedAt?: string };

export type OpeningLabel = 'open' | 'provisional' | 'watch' | 'held';
export function openingLabel(o: Opening): OpeningLabel {
  if (o.status === 'held') return 'held';
  if (o.status === 'watch') return 'watch';
  return o.windowClosesBy ? 'provisional' : 'open';
}
/** Month-level dates ('YYYY-MM' or a day of '01' flagged by the source) get a "month-level date" chip. */
export const isMonthLevel = (date: string | null | undefined) => !!date && date.length === 7;

export interface Sourced<T> { data: T; source: Provenance; evidence: Evidence[] }

// ---------------------------------------------------------------- fixtures
// From the live O1 result (14:13 IST, 22 Nov). Labelled "fixture" wherever shown. Departures are role + initial
// only; the candidate is fictional until a real consenting person is chosen.

const RETRIEVED = '2026-11-22T08:40:00.000Z';
const ev = (id: string, claim: string, observedAt: string | null, endpoint: string, url?: string, value?: string | number): Evidence => ({
  id, claim, value: value ?? null, source: { provider: url?.includes('thenextweb') ? 'web' : 'crustdata', endpoint, url },
  observedAt, retrievedAt: RETRIEVED, mode: 'fixture', verifiable: observedAt != null,
});

export const FIXTURE_EVIDENCE: Evidence[] = [
  ev('ev_fx_abacus_dep1', 'An ML Platform Engineer (P.) left Abacus.AI for Arcfront', '2026-10', 'person_recent_moves'),
  ev('ev_fx_abacus_dep2', 'An ML Platform Engineer (P.) left Abacus.AI for Bravebird', '2026-10', 'person_recent_moves'),
  ev('ev_fx_abacus_norepl', 'No ML-platform job posts or hires at Abacus.AI since 1 Oct (checked 22 Nov)', '2026-11-22', 'job_search', undefined, 0),
  ev('ev_fx_abacus_size', 'Abacus.AI had 288 employees', '2026-11-21', 'company_enrich', 'https://abacus.ai', 288),
  ev('ev_fx_pool_dep1', 'An Inference Engineer (M.) left Poolside for NVIDIA', '2026-09', 'person_recent_moves'),
  ev('ev_fx_pool_dep2', 'An Inference Engineer (J.) left Poolside for NVIDIA', '2026-09', 'person_recent_moves'),
  ev('ev_fx_pool_acq', 'Nvidia pays Poolside $6bn to license its model factory and hire 109 staff', '2026-08-21', 'web_search', 'https://thenextweb.com/'),
  ev('ev_fx_pool_size', 'Poolside had 302 employees', '2026-11-21', 'company_enrich', 'https://poolside.ai', 302),
  ev('ev_fx_cand_li', 'LinkedIn profile: ML Platform Engineer, about 4 years on Kubernetes-based training and serving platforms', '2026-11-22', 'person_enrich', 'https://www.linkedin.com/in/fictional-demo-candidate'),
];

const ABACUS = {
  id: 'co_fx_abacus', name: 'Abacus.AI', aliases: ['Abacus.AI', 'Abacus AI'], domain: 'abacus.ai', headcount: 288,
  industry: 'AI platform', hq: 'San Francisco', evidenceIds: ['ev_fx_abacus_size'],
};
const POOLSIDE = {
  id: 'co_fx_poolside', name: 'Poolside', aliases: ['Poolside', 'poolside'], domain: 'poolside.ai', headcount: 302,
  industry: 'AI models', hq: 'Paris', evidenceIds: ['ev_fx_pool_size'],
};

const OPENING_ABACUS: Opening = {
  id: 'op_fx_abacus_mlplat', companyId: ABACUS.id, companyName: ABACUS.name, roleFamily: 'ml_platform',
  roleTitle: 'ML Platform Engineer', status: 'open', confidence: 0.72, predictedAt: '2026-11-22', rule: 'O1',
  windowClosesBy: '2026-11-30', runId: 'run_fixture',
  reasons: [
    { kind: 'talent_drain', label: '2 ML Platform Engineers left in Oct', date: '2026-10', evidenceId: 'ev_fx_abacus_dep1' },
    { kind: 'no_replacement', label: 'No ML-platform post or hire since 1 Oct', date: '2026-11-22', evidenceId: 'ev_fx_abacus_norepl' },
    { kind: 'headcount', label: '288 staff, inside the 20–5,000 range', date: '2026-11-21', evidenceId: 'ev_fx_abacus_size' },
  ],
  evidenceIds: ['ev_fx_abacus_dep1', 'ev_fx_abacus_dep2', 'ev_fx_abacus_norepl', 'ev_fx_abacus_size'],
};

const OPENING_POOLSIDE: Opening = {
  id: 'op_fx_poolside_inf', companyId: POOLSIDE.id, companyName: POOLSIDE.name, roleFamily: 'inference',
  roleTitle: 'Inference Engineer', status: 'held', confidence: 0.2, predictedAt: '2026-11-22', rule: 'O1', runId: 'run_fixture',
  reasons: [
    { kind: 'talent_drain', label: '2 Inference Engineers left for NVIDIA in Sep', date: '2026-09', evidenceId: 'ev_fx_pool_dep1' },
    { kind: 'news', label: 'NVIDIA licensing deal and acqui-hire of 109 staff', date: '2026-08-21', evidenceId: 'ev_fx_pool_acq' },
  ],
  holdReasons: ['Acqui-hire: the engineers moved as part of a deal, not a drain'],
  evidenceIds: ['ev_fx_pool_dep1', 'ev_fx_pool_dep2', 'ev_fx_pool_acq', 'ev_fx_pool_size'],
};

const FUNNEL: Funnel[] = [
  { label: 'job moves read', count: 1410 },
  { label: 'left a tracked role family', count: 281 },
  { label: 'conclusive dates and titles', count: 176 },
  { label: 'companies with 2 or more', count: 4 },
  { label: 'predicted opening', count: 1 },
  { label: 'held', count: 1 },
];

const FIXTURE_CANDIDATE: Candidate = {
  id: 'cand_fx_rahul', status: 'ready', linkedinUrl: 'https://www.linkedin.com/in/fictional-demo-candidate',
  displayName: 'Rahul S.', headline: 'ML Platform Engineer', roleFamily: 'ml_platform',
  skills: ['Kubernetes', 'Ray', 'Triton Inference Server', 'Feature stores', 'Python', 'Go'],
  history: [
    { company: 'Fictional Labs', title: 'ML Platform Engineer', from: '2023-02', to: null },
    { company: 'Example Data Co', title: 'Backend Engineer', from: '2020-07', to: '2023-01' },
  ],
  consent: { shareHistory: true, shareSkills: true, shareSamples: false, discoverable: true },
  confirmedAt: null, samples: [], evidenceIds: ['ev_fx_cand_li'], runId: 'run_fixture', parsedBy: 'rules', fixture: true,
};

const MATCH_ABACUS: Match = {
  candidateId: FIXTURE_CANDIDATE.id, candidateLabel: FIXTURE_CANDIDATE.displayName, openingId: OPENING_ABACUS.id, score: 0.78,
  fit: [
    { text: 'Same role family: ML platform, about 4 years', status: 'verified', profileField: 'history', evidenceId: 'ev_fx_abacus_dep1' },
    { text: 'Kubernetes and Ray, the stack the departed engineers ran', status: 'verified', profileField: 'skills', evidenceId: 'ev_fx_cand_li' },
    { text: 'Led a feature-store migration (work sample not shared)', status: 'cant_verify', profileField: 'samples' },
  ],
};

const departure = (id: string, companyId: string, role: string, roleFamily: RoleFamily, initial: string, date: string, to: string, evidenceId: string): Departure =>
  ({ id, companyId, role, roleFamily, initial, date, precision: 'month', toCompanyId: null, toCompanyName: to, evidenceId });

// ---------------------------------------------------------------- client

export interface DeskApi {
  createCandidate(input: { linkedinUrl: string; samples: string[]; consent: Consent; dataMode?: 'fixture' | 'cache' | 'live' }): Promise<Sourced<{ candidateId: string; runId: string | null }>>;
  candidate(id: string): Promise<Sourced<Candidate>>;
  confirmCandidate(id: string, consent: Consent): Promise<Sourced<Candidate>>;
  candidateOpenings(id: string): Promise<Sourced<Opening[]>>;
  candidateInbox(id: string): Promise<Sourced<IntroRequest[]>>;
  requestIntro(candidateId: string, openingId: string): Promise<Sourced<IntroRequest>>;
  companies(): Promise<Sourced<CompanySummary[]>>;
  company(id: string): Promise<Sourced<CompanyDesk>>;
  dossier(id: string, runId?: string): Promise<Sourced<CompanyDossier>>;
  /** User-initiated only (a button). Never on load, poll or navigation. Defaults to cache mode: 0 credits. */
  scanOpenings(dataMode?: 'cache' | 'live'): Promise<{ runId: string } | null>;
}

export class NotLive extends Error {}

// An endpoint family that answered 404 once isn't built on this server: don't call it again this session (keeps the
// console clean and avoids a round trip per tab). A route key replaces ids with ':id'.
const missing = new Set<string>();
const routeKey = (url: string, method = 'GET') => `${method} ${url.split('?')[0].replace(/\/(co|cand|run|op|intro)_[^/]+/g, '/:id').replace(/\/companies\/[^/]+/, '/companies/:id').replace(/\/candidates\/[^/]+/, '/candidates/:id')}`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const key = routeKey(url, init?.method);
  if (missing.has(key)) throw new NotLive(url);
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new NotLive(url);
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    // The server's codes decide (shared API_ERROR): a non-JSON 404 or the catch-all means the endpoint isn't built;
    // "no data yet" falls back without hiding the route; any other error is a real answer about this id.
    const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    if (body?.code === API_ERROR.noData) throw new NotLive(url);
    if (body?.error && body.code !== API_ERROR.routeMissing) throw new Error(body.error);
    missing.add(key);
    throw new NotLive(url);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new NotLive(url); // the SPA fallback answered: endpoint not built yet
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
const postJson = <T>(url: string, body: unknown) =>
  getJson<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const fx = <T>(data: T): Sourced<T> => ({ data: structuredClone(data), source: 'fixture', evidence: FIXTURE_EVIDENCE });

/** The live answer, or null when the server can't give one (endpoint not built, no data yet, offline). */
async function orNull<T>(live: () => Promise<T>): Promise<T | null> {
  try {
    return await live();
  } catch (e) {
    if (e instanceof NotLive) return null;
    throw e;
  }
}
export const tryJson = <T>(url: string, init?: RequestInit) => orNull(() => getJson<T>(url, init));

async function liveOr<T>(live: () => Promise<Sourced<T>>, fallback: () => Sourced<T>, forceFixture: boolean): Promise<Sourced<T>> {
  return (forceFixture ? null : await orNull(live)) ?? fallback();
}

/** Fixture rows (the demo candidate, the fictional companies and openings) carry `_fx_` ids the live server never saw. */
export const isFixtureId = (id: string) => id.includes('_fx_');

/** Live responses either are the value or wrap it ({openings: [...]}); evidence rows ride along when present. */
function unwrap<T>(r: unknown, key?: string): Sourced<T> {
  const o = r as Record<string, unknown>;
  const data = (key && o && !Array.isArray(o) && key in o ? o[key] : r) as T;
  const evidence = (o && !Array.isArray(o) && Array.isArray(o.evidence) ? o.evidence : []) as Evidence[];
  const fixture = (o && !Array.isArray(o) && (o.fixture === true || o.source === 'fixture'));
  return { data, source: fixture ? 'fixture' : 'live', evidence };
}

export function createDeskApi(opts: { fixtureOnly: boolean }): DeskApi {
  const f = opts.fixtureOnly;
  const fixtureFor = (...ids: string[]) => f || ids.some(isFixtureId);
  let candidate = structuredClone(FIXTURE_CANDIDATE);
  const inbox: IntroRequest[] = [];
  return {
    createCandidate: (input) => liveOr(
      async () => unwrap(await postJson('/api/candidates', input)),
      () => {
        candidate = { ...structuredClone(FIXTURE_CANDIDATE), linkedinUrl: input.linkedinUrl || FIXTURE_CANDIDATE.linkedinUrl, consent: input.consent, samples: input.samples };
        return fx({ candidateId: candidate.id, runId: null });
      }, f),
    candidate: (id) => liveOr(async () => unwrap(await getJson(`/api/candidates/${id}`), 'candidate'), () => fx(candidate), fixtureFor(id)),
    confirmCandidate: (id, consent) => liveOr(
      async () => unwrap(await postJson(`/api/candidates/${id}/confirm`, { consent }), 'candidate'),
      () => { candidate = { ...candidate, consent, confirmedAt: new Date().toISOString() }; return fx(candidate); }, fixtureFor(id)),
    candidateOpenings: (id) => liveOr<Opening[]>(
      async () => unwrap<OpeningForCandidate[]>(await getJson(`/api/candidates/${id}/openings`), 'openings'),
      () => fx<Opening[]>([{ ...OPENING_ABACUS, fit: MATCH_ABACUS.fit, matchScore: MATCH_ABACUS.score }, OPENING_POOLSIDE]), fixtureFor(id)),
    candidateInbox: (id) => liveOr(
      async () => unwrap<IntroRequest[]>(await getJson(`/api/candidates/${id}/inbox`), 'requests'),
      () => fx(inbox), fixtureFor(id)),
    requestIntro: (candidateId, openingId) => liveOr(
      async () => unwrap(await postJson(`/api/candidates/${candidateId}/intros`, { openingId }), 'intro'),
      () => {
        const existing = inbox.find((r) => r.openingId === openingId && r.direction === 'candidate_to_company');
        if (existing) return fx(existing);
        const req: IntroRequest = {
          id: `intro_fx_${inbox.length + 1}`, direction: 'candidate_to_company', candidateId, companyId: OPENING_ABACUS.companyId,
          companyName: OPENING_ABACUS.companyName, openingId, roleTitle: OPENING_ABACUS.roleTitle, status: 'awaiting_approval',
          runId: null, receivedAt: new Date().toISOString(),
          message: 'Intro requested. The company sees only the profile fields you agreed to share.',
        };
        inbox.push(req);
        return fx(req);
      }, fixtureFor(candidateId, openingId)),
    companies: () => liveOr(
      async () => {
        const r = unwrap<CompanySummary[]>(await getJson('/api/companies'), 'companies');
        // Companies with a rule decision first, then by departures; the rest stay reachable through search.
        const rank = (c: CompanySummary) => (c.openings ? 1000 : 0) + ((c.held ?? 0) ? 500 : 0) + c.departures90d;
        return { ...r, data: [...r.data].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)) };
      },
      () => fx<CompanySummary[]>([
        { id: ABACUS.id, name: ABACUS.name, domain: ABACUS.domain, headcount: 288, openings: 1, held: 0, departures90d: 2 },
        { id: POOLSIDE.id, name: POOLSIDE.name, domain: POOLSIDE.domain, headcount: 302, openings: 0, held: 1, departures90d: 2 },
      ]), f),
    company: (id) => liveOr(
      async () => { const r = unwrap<CompanyDesk>(await getJson(`/api/companies/${id}`)); return { ...r, evidence: r.data.evidence ?? r.evidence }; },
      () => {
        const pool = id === POOLSIDE.id || id === 'poolside';
        const desk: CompanyDesk = pool
          ? {
            company: POOLSIDE, openings: [OPENING_POOLSIDE], matches: [], intros: [], runId: null, replay: null, evidence: FIXTURE_EVIDENCE,
            funnel: FUNNEL, checkedAt: RETRIEVED,
            departures: [
              departure('dp_fx_p1', POOLSIDE.id, 'Inference Engineer', 'inference', 'M.', '2026-09', 'NVIDIA', 'ev_fx_pool_dep1'),
              departure('dp_fx_p2', POOLSIDE.id, 'Inference Engineer', 'inference', 'J.', '2026-09', 'NVIDIA', 'ev_fx_pool_dep2'),
            ],
          }
          : {
            company: ABACUS, openings: [OPENING_ABACUS], matches: [MATCH_ABACUS], intros: [...inbox], runId: null, replay: null,
            evidence: FIXTURE_EVIDENCE, funnel: FUNNEL, checkedAt: RETRIEVED,
            departures: [
              departure('dp_fx_a1', ABACUS.id, 'ML Platform Engineer', 'ml_platform', 'P.', '2026-10', 'Arcfront', 'ev_fx_abacus_dep1'),
              departure('dp_fx_a2', ABACUS.id, 'ML Platform Engineer', 'ml_platform', 'P.', '2026-10', 'Bravebird', 'ev_fx_abacus_dep2'),
            ],
          };
        return fx(desk);
      }, fixtureFor(id)),
    dossier: (id, runId) => liveOr(
      async () => { const r = unwrap<CompanyDossier>(await getJson(`/api/companies/${encodeURIComponent(id)}/dossier${runId ? `?run=${runId}` : ''}`)); return { ...r, source: r.data.dataMode === 'fixture' ? 'fixture' : r.data.dataMode === 'cache' ? 'cache' : 'live', evidence: r.data.evidence }; },
      () => { throw new Error('No analysis run contains this company yet. Run a company analysis first.'); }, fixtureFor(id)),
    async scanOpenings(dataMode: 'cache' | 'live' = 'cache') {
      if (f) return null;
      try { return await postJson<{ runId: string }>('/api/openings/scan', { dataMode }); } catch { return null; }
    },
  };
}

export const HERO_COMPANY_ID = ABACUS.id;
