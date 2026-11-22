// The Search Desk API that v2 consumes (candidate and company sides). Proposed to domino-lead at 14:12 IST; the
// live server implements it as it lands. Each call tries the live endpoint first and falls back to the labelled
// fixture below when the endpoint doesn't exist yet, and every response says which one it came from.
import type { Company, Evidence } from '../../../shared/types.ts';

export type Provenance = 'live' | 'cache' | 'fixture' | 'sample';

export type OpeningStatus = 'open' | 'provisional' | 'watch' | 'held';
export type ReasonKind = 'talent_drain' | 'no_replacement' | 'funding' | 'news' | 'headcount';

export interface ReasonChip {
  kind: ReasonKind;
  label: string;             // "2 ML Platform Engineers left in Oct"
  date: string | null;       // ISO day or 'YYYY-MM' for month-level dates
  precision: 'day' | 'month';
  evidenceId: string | null;
}

export interface Opening {
  id: string;
  companyId: string;
  companyName: string;
  roleFamily: string;        // "ML platform"
  roleTitle: string;         // "ML Platform Engineer"
  status: OpeningStatus;
  confidence: number;        // 0..1
  predictedAt: string;       // ISO day
  rule: 'O1';
  reasons: ReasonChip[];
  windowClosesBy?: string | null;   // provisional: the replacement window closes on this day
  holdReasons?: { text: string; evidenceId: string | null }[];
  watch?: { have: number; need: number } | null;
  evidenceIds: string[];
  /** fit for the signed-in candidate (candidate dashboard only) */
  fit?: Match | null;
}

export interface FitReason {
  text: string;
  status: 'verified' | 'cant_verify';
  profileField?: string | null;     // consented profile field the reason cites
  evidenceId?: string | null;       // opening evidence the reason cites
  note?: string | null;             // why it can't be verified
}

export interface Match {
  candidateId: string;
  candidateLabel: string;           // "Rahul S." (first name + initial)
  openingId: string;
  score: number;                    // 0..1
  fit: FitReason[];
}

export interface Departure {
  id: string;
  role: string;                     // "ML Platform Engineer"
  initial: string;                  // "P."
  date: string;                     // 'YYYY-MM' (month-level) or ISO day
  precision: 'day' | 'month';
  toCompanyId: string | null;
  toCompanyName: string;
  evidenceId: string | null;
}

export interface Consent {
  shareHistory: boolean;
  shareSkills: boolean;
  shareSamples: boolean;
  discoverable: boolean;            // companies with a matching opening may request an intro
}

export interface CandidateProfile {
  id: string;
  status: 'enriching' | 'ready' | 'failed';
  linkedinUrl: string;
  displayName: string;              // first name + last initial
  headline: string;
  roleFamily: string;
  skills: string[];
  history: { company: string; title: string; from: string | null; to: string | null }[];
  consent: Consent;
  confirmed: boolean;
  samples: string[];
  evidenceIds: string[];
  runId: string | null;
  parsedBy: string;                 // "llm:gpt-6-luna" | "rules"
  fictional?: boolean;              // fixture candidate: always labelled
}

export interface IntroRequest {
  id: string;
  companyId: string;
  companyName: string;
  openingId: string;
  roleTitle: string;
  direction: 'from_company' | 'from_candidate';
  message: string;
  status: 'new' | 'accepted' | 'declined' | 'requested';
  receivedAt: string;
}

export interface CompanySummary {
  id: string;
  name: string;
  domain: string | null;
  headcount: number | null;
  openings: number;
  held: number;
  departures90d: number;
}

export interface Funnel { label: string; count: number }

export interface CompanyDesk {
  company: Company;
  departures: Departure[];
  openings: Opening[];
  matches: Match[];
  runId: string | null;             // the outreach run (drafts, approvals, outbox) reuse RunSnapshot
  funnel: Funnel[];
  checkedAt: string;                // ISO datetime the cohort was last read
}

export interface Sourced<T> { data: T; source: Provenance; evidence: Evidence[] }

// ---------------------------------------------------------------- fixtures
// Built from the live O1 result (14:13 IST, 22 Nov). Labelled "fixture" wherever shown. Person names never appear:
// departures are role + initial; the candidate is fictional until a real consenting person is chosen.

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
  ev('ev_fx_cand_li', 'LinkedIn profile: ML Platform Engineer, 4 years on Kubernetes-based training and serving platforms', '2026-11-22', 'person_enrich', 'https://www.linkedin.com/in/fictional-demo-candidate'),
];

const ABACUS: Company = {
  id: 'co_fx_abacus', name: 'Abacus.AI', aliases: ['Abacus.AI', 'Abacus AI'], domain: 'abacus.ai', headcount: 288,
  industry: 'AI platform', hq: 'San Francisco', evidenceIds: ['ev_fx_abacus_size'],
};
const POOLSIDE: Company = {
  id: 'co_fx_poolside', name: 'Poolside', aliases: ['Poolside', 'poolside'], domain: 'poolside.ai', headcount: 302,
  industry: 'AI models', hq: 'Paris', evidenceIds: ['ev_fx_pool_size'],
};

const OPENING_ABACUS: Opening = {
  id: 'op_fx_abacus_mlplat', companyId: ABACUS.id, companyName: ABACUS.name, roleFamily: 'ML platform',
  roleTitle: 'ML Platform Engineer', status: 'provisional', confidence: 0.72, predictedAt: '2026-11-22', rule: 'O1',
  windowClosesBy: '2026-11-30',
  reasons: [
    { kind: 'talent_drain', label: '2 ML Platform Engineers left in Oct', date: '2026-10', precision: 'month', evidenceId: 'ev_fx_abacus_dep1' },
    { kind: 'no_replacement', label: 'No ML-platform post or hire since 1 Oct', date: '2026-11-22', precision: 'day', evidenceId: 'ev_fx_abacus_norepl' },
    { kind: 'headcount', label: '288 staff, inside the 20–5,000 range', date: '2026-11-21', precision: 'day', evidenceId: 'ev_fx_abacus_size' },
  ],
  evidenceIds: ['ev_fx_abacus_dep1', 'ev_fx_abacus_dep2', 'ev_fx_abacus_norepl', 'ev_fx_abacus_size'],
};

const OPENING_POOLSIDE: Opening = {
  id: 'op_fx_poolside_inf', companyId: POOLSIDE.id, companyName: POOLSIDE.name, roleFamily: 'Inference',
  roleTitle: 'Inference Engineer', status: 'held', confidence: 0.2, predictedAt: '2026-11-22', rule: 'O1',
  reasons: [
    { kind: 'talent_drain', label: '2 Inference Engineers left for NVIDIA in Sep', date: '2026-09', precision: 'month', evidenceId: 'ev_fx_pool_dep1' },
    { kind: 'news', label: 'NVIDIA licensing deal and acqui-hire of 109 staff', date: '2026-08-21', precision: 'day', evidenceId: 'ev_fx_pool_acq' },
  ],
  holdReasons: [{ text: 'Acqui-hire: the engineers moved as part of a deal, not a drain', evidenceId: 'ev_fx_pool_acq' }],
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

const FIXTURE_CANDIDATE: CandidateProfile = {
  id: 'cand_fx_rahul', status: 'ready', linkedinUrl: 'https://www.linkedin.com/in/fictional-demo-candidate',
  displayName: 'Rahul S.', headline: 'ML Platform Engineer',
  roleFamily: 'ML platform', skills: ['Kubernetes', 'Ray', 'Triton Inference Server', 'Feature stores', 'Python', 'Go'],
  history: [
    { company: 'Fictional Labs', title: 'ML Platform Engineer', from: '2023-02', to: null },
    { company: 'Example Data Co', title: 'Backend Engineer', from: '2020-07', to: '2023-01' },
  ],
  consent: { shareHistory: true, shareSkills: true, shareSamples: false, discoverable: true },
  confirmed: false, samples: [], evidenceIds: ['ev_fx_cand_li'], runId: null, parsedBy: 'fixture', fictional: true,
};

const MATCH_ABACUS: Match = {
  candidateId: FIXTURE_CANDIDATE.id, candidateLabel: FIXTURE_CANDIDATE.displayName, openingId: OPENING_ABACUS.id, score: 0.78,
  fit: [
    { text: 'Same role family: ML platform, about 4 years', status: 'verified', profileField: 'history', evidenceId: 'ev_fx_abacus_dep1' },
    { text: 'Kubernetes and Ray, the stack the departed engineers ran', status: 'verified', profileField: 'skills', evidenceId: 'ev_fx_cand_li' },
    { text: 'Led a feature-store migration', status: 'cant_verify', profileField: 'samples', note: 'Work sample not shared, so this stays out of the intro' },
  ],
};

const INBOX: IntroRequest[] = [];

// ---------------------------------------------------------------- client

export interface DeskApi {
  createCandidate(input: { linkedinUrl: string; samples: string[]; consent: Consent }): Promise<Sourced<{ candidateId: string; runId: string | null }>>;
  candidate(id: string): Promise<Sourced<CandidateProfile>>;
  confirmCandidate(id: string, consent: Consent): Promise<Sourced<CandidateProfile>>;
  candidateOpenings(id: string): Promise<Sourced<Opening[]>>;
  candidateInbox(id: string): Promise<Sourced<IntroRequest[]>>;
  requestIntro(candidateId: string, openingId: string): Promise<Sourced<IntroRequest>>;
  companies(): Promise<Sourced<CompanySummary[]>>;
  company(id: string): Promise<Sourced<CompanyDesk>>;
  evidence(ids: string[]): Promise<Evidence[]>;
}

class NotLive extends Error {}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new NotLive(url);
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) throw new NotLive(url);
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

const fx = <T>(data: T, evidence: Evidence[] = FIXTURE_EVIDENCE): Sourced<T> => ({ data: structuredClone(data), source: 'fixture', evidence });

/** Live first; a missing endpoint falls back to the fixture. Real errors (400, 500) still surface. */
async function liveOr<T>(live: () => Promise<Sourced<T>>, fallback: () => Sourced<T>, forceFixture: boolean): Promise<Sourced<T>> {
  if (forceFixture) return fallback();
  try {
    return await live();
  } catch (e) {
    if (e instanceof NotLive) return fallback();
    throw e;
  }
}

type LiveShape<T> = T & { evidence?: Evidence[]; source?: Provenance };
const wrap = <T>(v: LiveShape<T>, source: Provenance = 'live'): Sourced<T> => ({ data: v, source: v.source ?? source, evidence: v.evidence ?? [] });

export function createDeskApi(opts: { fixtureOnly: boolean }): DeskApi {
  const f = opts.fixtureOnly;
  let candidate = structuredClone(FIXTURE_CANDIDATE);
  const inbox = structuredClone(INBOX);
  return {
    createCandidate: (input) => liveOr(
      async () => wrap(await postJson<LiveShape<{ candidateId: string; runId: string | null }>>('/api/candidates', input)),
      () => {
        candidate = { ...structuredClone(FIXTURE_CANDIDATE), linkedinUrl: input.linkedinUrl || FIXTURE_CANDIDATE.linkedinUrl, consent: input.consent, samples: input.samples };
        return fx({ candidateId: candidate.id, runId: null });
      }, f),
    candidate: (id) => liveOr(async () => wrap(await getJson<LiveShape<CandidateProfile>>(`/api/candidates/${id}`)), () => fx(candidate), f),
    confirmCandidate: (id, consent) => liveOr(
      async () => wrap(await postJson<LiveShape<CandidateProfile>>(`/api/candidates/${id}/confirm`, { consent })),
      () => { candidate = { ...candidate, consent, confirmed: true }; return fx(candidate); }, f),
    candidateOpenings: (id) => liveOr(
      async () => { const r = await getJson<LiveShape<{ openings: Opening[] }> | Opening[]>(`/api/candidates/${id}/openings`); return Array.isArray(r) ? wrap(Object.assign(r, {})) : { data: r.openings, source: r.source ?? 'live', evidence: r.evidence ?? [] }; },
      () => fx([{ ...OPENING_ABACUS, fit: MATCH_ABACUS }, OPENING_POOLSIDE]), f),
    candidateInbox: (id) => liveOr(
      async () => { const r = await getJson<LiveShape<{ requests: IntroRequest[] }> | IntroRequest[]>(`/api/candidates/${id}/inbox`); return Array.isArray(r) ? wrap(Object.assign(r, {})) : { data: r.requests, source: r.source ?? 'live', evidence: r.evidence ?? [] }; },
      () => fx(inbox), f),
    requestIntro: (candidateId, openingId) => liveOr(
      async () => wrap(await postJson<LiveShape<IntroRequest>>(`/api/candidates/${candidateId}/intros`, { openingId })),
      () => {
        const existing = inbox.find((r) => r.openingId === openingId && r.direction === 'from_candidate');
        if (existing) return fx(existing);
        const req: IntroRequest = {
          id: `intro_fx_${inbox.length + 1}`, companyId: OPENING_ABACUS.companyId, companyName: OPENING_ABACUS.companyName, openingId,
          roleTitle: OPENING_ABACUS.roleTitle, direction: 'from_candidate', status: 'requested', receivedAt: new Date().toISOString(),
          message: 'You asked for an intro. The company sees your consented profile fields only.',
        };
        inbox.push(req);
        return fx(req);
      }, f),
    companies: () => liveOr(
      async () => { const r = await getJson<LiveShape<{ companies: CompanySummary[] }> | CompanySummary[]>('/api/companies'); return Array.isArray(r) ? wrap(Object.assign(r, {})) : { data: r.companies, source: r.source ?? 'live', evidence: r.evidence ?? [] }; },
      () => fx<CompanySummary[]>([
        { id: ABACUS.id, name: ABACUS.name, domain: ABACUS.domain ?? null, headcount: 288, openings: 1, held: 0, departures90d: 2 },
        { id: POOLSIDE.id, name: POOLSIDE.name, domain: POOLSIDE.domain ?? null, headcount: 302, openings: 0, held: 1, departures90d: 2 },
      ]), f),
    company: (id) => liveOr(
      async () => wrap(await getJson<LiveShape<CompanyDesk>>(`/api/companies/${id}`)),
      () => {
        const isPool = id === POOLSIDE.id;
        const desk: CompanyDesk = isPool
          ? {
            company: POOLSIDE, openings: [OPENING_POOLSIDE], matches: [], runId: null, funnel: FUNNEL, checkedAt: RETRIEVED,
            departures: [
              { id: 'dp_fx_p1', role: 'Inference Engineer', initial: 'M.', date: '2026-09', precision: 'month', toCompanyId: null, toCompanyName: 'NVIDIA', evidenceId: 'ev_fx_pool_dep1' },
              { id: 'dp_fx_p2', role: 'Inference Engineer', initial: 'J.', date: '2026-09', precision: 'month', toCompanyId: null, toCompanyName: 'NVIDIA', evidenceId: 'ev_fx_pool_dep2' },
            ],
          }
          : {
            company: ABACUS, openings: [OPENING_ABACUS], matches: [MATCH_ABACUS], runId: null, funnel: FUNNEL, checkedAt: RETRIEVED,
            departures: [
              { id: 'dp_fx_a1', role: 'ML Platform Engineer', initial: 'P.', date: '2026-10', precision: 'month', toCompanyId: null, toCompanyName: 'Arcfront', evidenceId: 'ev_fx_abacus_dep1' },
              { id: 'dp_fx_a2', role: 'ML Platform Engineer', initial: 'P.', date: '2026-10', precision: 'month', toCompanyId: null, toCompanyName: 'Bravebird', evidenceId: 'ev_fx_abacus_dep2' },
            ],
          };
        return fx(desk);
      }, f),
    async evidence(ids) {
      const local = FIXTURE_EVIDENCE.filter((e) => ids.includes(e.id));
      if (f || local.length === ids.length) return local;
      try {
        const r = await getJson<{ evidence: Evidence[] } | Evidence[]>(`/api/evidence?ids=${encodeURIComponent(ids.join(','))}`);
        return Array.isArray(r) ? r : r.evidence;
      } catch {
        return local;
      }
    },
  };
}

export const HERO_COMPANY_ID = ABACUS.id;
