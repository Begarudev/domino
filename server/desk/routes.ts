// Search Desk HTTP API. OWNER: domino-desk-api (candidate + company endpoints); openings data comes from the latest
// openings-pipeline run (OWNER: domino-livedata). Contract: shared/desk.ts + docs/CONTRACT.md "Search Desk".
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Company, Evidence, Pipeline, RunLimits } from '../../shared/types.ts';
import type { Candidate, CompanySummary, CompanyView, IntroRequest, Opening } from '../../shared/desk.ts';
import type { Store } from '../db.ts';
import { linkedinProfileUrl } from '../crustdata/person-enrich.ts';
import type { CandidateOutputs } from '../engine/candidate-steps.ts';
import { sanitize } from '../runtime/tool.ts';
import { matchesFor, openingsForCandidate } from './match.ts';
import {
  candidateEvidence, candidateView, confirmCandidate, getCandidateRow, insertCandidate, insertIntro, latestOpeningsRunId,
  listCandidateRows, listIntroRows, openingsSnapshot, setCandidateRun, setIntroRun,
} from './store.ts';
import type { IntroRow, OpeningsSnapshot } from './store.ts';

export interface DeskDeps {
  store: Store;
  // Creates a run of the given pipeline and forks its engine worker; returns the run id.
  launch(pipeline: Pipeline, request: string, options?: { limits?: Partial<RunLimits>; dataMode?: 'live' | 'cache' | 'fixture' }): string;
}

const consentSchema = z.object({
  shareHistory: z.boolean(), shareSkills: z.boolean(), shareSamples: z.boolean(), discoverable: z.boolean(),
}).strict();
const candidateSchema = z.object({
  linkedinUrl: z.string().max(300),
  samples: z.array(z.string().max(2000)).max(5).optional(),
  consent: consentSchema,
  dataMode: z.enum(['live', 'cache', 'fixture']).optional(),
});
// One enrich call lists at 1-9 credits; cap the candidate run far below the 600 per-run ceiling.
const CANDIDATE_LIMITS: Partial<RunLimits> = { maxCredits: 25 };

const byId = <T extends { id: string }>(rows: T[]) => [...new Map(rows.map(row => [row.id, row])).values()];
const pick = (evidence: Evidence[], ids: Iterable<string>) => {
  const wanted = new Set(ids);
  return evidence.filter(row => wanted.has(row.id));
};
const shortId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function deskRoutes({ store, launch }: DeskDeps) {
  const api = new Hono();

  const introView = (row: IntroRow): IntroRequest => {
    const snapshot = openingsSnapshot(store, row.openingsRunId);
    const opening = snapshot?.openings.find(item => item.id === row.openingId);
    const drafted = row.runId ? store.getOutput<CandidateOutputs['draft_intro']>(row.runId, 'draft_intro') : undefined;
    const approval = row.runId ? store.getApprovals(row.runId)[0] : undefined;
    const delivered = Boolean(row.runId && approval && store.getOutbox(row.runId).some(action => action.approvalId === approval.id));
    const status: IntroRequest['status'] = delivered ? 'delivered' : approval?.status === 'rejected' ? 'declined'
      : approval?.status === 'pending' ? 'awaiting_approval' : 'new';
    return {
      id: row.id, direction: row.direction, candidateId: row.candidateId, companyId: row.companyId,
      companyName: opening?.companyName ?? drafted?.company.name ?? row.companyId, openingId: row.openingId,
      roleTitle: opening?.roleTitle ?? drafted?.roleTitle ?? '', message: drafted?.draft?.body ?? '', status, runId: row.runId,
      approvalId: approval?.id ?? null, evidenceIds: drafted?.draft?.citations.map(item => item.evidenceId) ?? [],
      receivedAt: row.createdAt,
    };
  };

  const startIntro = (direction: IntroRow['direction'], candidate: Candidate, opening: Opening, snapshot: OpeningsSnapshot) => {
    // One intro per direction, candidate and opening: a repeated request returns the existing one.
    const existing = listIntroRows(store, { candidateId: candidate.id })
      .find(row => row.direction === direction && row.openingId === opening.id && row.runId);
    if (existing) return { intro: introView(existing), created: false };
    const id = shortId('in');
    insertIntro(store, { id, direction, candidateId: candidate.id, companyId: opening.companyId, openingId: opening.id,
      openingsRunId: snapshot.runId });
    setIntroRun(store, id, launch('intro', `intro:${id}`));
    return { intro: introView(listIntroRows(store, { candidateId: candidate.id }).find(row => row.id === id)!), created: true };
  };

  const loadCandidate = (id: string) => {
    const row = getCandidateRow(store, id);
    return row ? candidateView(store, row) : undefined;
  };

  // ---------- openings ----------

  api.post('/openings/scan', async c => {
    const body = await c.req.json().catch(() => ({})) as { request?: string };
    const runId = launch('openings', body.request?.trim() || 'Predict openings in inference, ML platform, MLOps and GPU/LLM infrastructure roles');
    return c.json({ runId }, 201);
  });

  // ---------- candidates ----------

  api.post('/candidates', async c => {
    const body = candidateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Expected linkedinUrl, consent {shareHistory, shareSkills, shareSamples, discoverable} and optional samples' }, 400);
    }
    const linkedinUrl = linkedinProfileUrl(body.data.linkedinUrl);
    if (!linkedinUrl) return c.json({ error: 'Expected a LinkedIn profile URL like https://www.linkedin.com/in/your-name/' }, 400);
    const candidateId = shortId('cand');
    const consent = { ...body.data.consent, recordedAt: new Date().toISOString() };
    const samples = (body.data.samples ?? []).map(sample => String(sanitize(sample.trim(), true))).filter(Boolean);
    insertCandidate(store, { id: candidateId, linkedinUrl, consent, samples });
    // The run request names only the candidate id; the profile URL stays in the candidate row.
    const runId = launch('candidate', `candidate:${candidateId}`, { limits: CANDIDATE_LIMITS, dataMode: body.data.dataMode });
    setCandidateRun(store, candidateId, runId);
    return c.json({ candidateId, runId }, 201);
  });

  api.get('/candidates/:id', c => {
    const candidate = loadCandidate(c.req.param('id'));
    if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
    return c.json({ ...candidate, evidence: candidateEvidence(store, candidate) });
  });

  api.post('/candidates/:id/confirm', async c => {
    const id = c.req.param('id');
    const candidate = loadCandidate(id);
    if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
    if (candidate.status !== 'ready') return c.json({ error: 'The profile is not ready to confirm yet' }, 409);
    const body = z.object({ consent: consentSchema.optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Expected an optional consent object' }, 400);
    confirmCandidate(store, id, body.data.consent);
    const confirmed = loadCandidate(id)!;
    return c.json({ ...confirmed, evidence: candidateEvidence(store, confirmed) });
  });

  api.get('/candidates/:id/openings', c => {
    const candidate = loadCandidate(c.req.param('id'));
    if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
    const snapshot = openingsSnapshot(store);
    if (candidate.status !== 'ready' || !snapshot) return c.json([]);
    return c.json(openingsForCandidate(candidate, snapshot.openings, snapshot.evidence));
  });

  api.get('/candidates/:id/inbox', c => {
    const id = c.req.param('id');
    if (!getCandidateRow(store, id)) return c.json({ error: 'Candidate not found' }, 404);
    return c.json(listIntroRows(store, { candidateId: id }).filter(row => row.direction === 'company_to_candidate').map(introView));
  });

  api.get('/candidates/:id/intros', c => {
    const id = c.req.param('id');
    if (!getCandidateRow(store, id)) return c.json({ error: 'Candidate not found' }, 404);
    return c.json(listIntroRows(store, { candidateId: id }).map(introView));
  });

  api.post('/candidates/:id/intros', async c => {
    const candidate = loadCandidate(c.req.param('id'));
    if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
    if (candidate.status !== 'ready' || !candidate.confirmedAt) return c.json({ error: 'Confirm your profile before requesting an intro' }, 409);
    const body = z.object({ openingId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected openingId' }, 400);
    const snapshot = openingsSnapshot(store);
    const opening = snapshot?.openings.find(item => item.id === body.data.openingId);
    if (!snapshot || !opening) return c.json({ error: 'Opening not found in the latest scan' }, 404);
    if (opening.status === 'held') return c.json({ error: 'Held: not an opening' }, 409);
    const { intro, created } = startIntro('candidate_to_company', candidate, opening, snapshot);
    return c.json(intro, created ? 201 : 200);
  });

  // ---------- companies ----------

  const companiesOf = (snapshot: OpeningsSnapshot): Company[] => byId([
    ...snapshot.companies,
    ...snapshot.openings.map(opening => ({ id: opening.companyId, name: opening.companyName, aliases: [], evidenceIds: [] })),
  ]);

  api.get('/companies', c => {
    const snapshot = openingsSnapshot(store);
    if (!snapshot) return c.json([]);
    const rows: CompanySummary[] = companiesOf(snapshot).map(company => ({
      id: company.id, name: company.name, domain: company.domain ?? null, headcount: company.headcount ?? null,
      openings: snapshot.openings.filter(opening => opening.companyId === company.id && opening.status === 'open').length,
      departures90d: snapshot.departures.filter(departure => departure.companyId === company.id).length,
    })).filter(row => row.departures90d || snapshot.openings.some(opening => opening.companyId === row.id));
    rows.sort((a, b) => b.openings - a.openings || b.departures90d - a.departures90d || a.name.localeCompare(b.name));
    return c.json(rows);
  });

  api.get('/companies/:id', c => {
    const id = c.req.param('id');
    const snapshot = openingsSnapshot(store);
    const company = snapshot && companiesOf(snapshot).find(item => item.id === id);
    if (!snapshot || !company) return c.json({ error: 'Company not found in the latest openings scan' }, 404);
    const openings = snapshot.openings.filter(opening => opening.companyId === id);
    const departures = snapshot.departures.filter(departure => departure.companyId === id);
    const candidates = listCandidateRows(store).map(row => candidateView(store, row))
      .filter(candidate => candidate.status === 'ready' && candidate.consent.discoverable);
    const matches = candidates.flatMap(candidate => matchesFor(candidate, openings, snapshot.evidence)).sort((a, b) => b.score - a.score);
    const intros = listIntroRows(store, { companyId: id }).map(introView);
    const replayRun = latestOpeningsRunId(store, true);
    const replay = replayRun ? openingsSnapshot(store, replayRun)?.replay ?? null : null;
    const cited = [
      ...company.evidenceIds, ...openings.flatMap(opening => opening.evidenceIds), ...departures.map(departure => departure.evidenceId),
      ...matches.flatMap(match => match.fit.flatMap(reason => reason.evidenceId ?? [])),
    ];
    const view: CompanyView = { company, departures, openings, matches, intros, runId: snapshot.runId, replay, evidence: pick(snapshot.evidence, cited) };
    return c.json(view);
  });

  api.post('/companies/:id/intros', async c => {
    const id = c.req.param('id');
    const body = z.object({ candidateId: z.string().min(1), openingId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected candidateId and openingId' }, 400);
    const candidate = loadCandidate(body.data.candidateId);
    // A non-discoverable candidate looks exactly like an unknown one from the company side.
    if (!candidate || !candidate.consent.discoverable || candidate.status !== 'ready') return c.json({ error: 'Candidate not found' }, 404);
    const snapshot = openingsSnapshot(store);
    const opening = snapshot?.openings.find(item => item.id === body.data.openingId && item.companyId === id);
    if (!snapshot || !opening) return c.json({ error: 'Opening not found for this company in the latest scan' }, 404);
    if (opening.status === 'held') return c.json({ error: 'Held: not an opening' }, 409);
    const { intro, created } = startIntro('company_to_candidate', candidate, opening, snapshot);
    return c.json(intro, created ? 201 : 200);
  });

  return api;
}
