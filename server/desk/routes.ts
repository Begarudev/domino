// Search Desk HTTP API. OWNER: domino-desk-api (candidate + company endpoints); openings data comes from the latest
// openings-pipeline run (OWNER: domino-livedata). Contract: shared/desk.ts + docs/CONTRACT.md "Search Desk".
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Evidence, Pipeline, RunLimits } from '../../shared/types.ts';
import type {
  Candidate, CompanyView, IntroPreview, IntroRequest, Match, Opening, OpeningForCandidate, OpeningsFunnel,
} from '../../shared/desk.ts';
import { ROLE_FAMILY_LABELS } from '../../shared/desk.ts';
import type { RoleFamily } from '../../shared/desk.ts';
import type { Store } from '../db.ts';
import { config } from '../env.ts';
import { linkedinProfileUrl } from '../crustdata/person-enrich.ts';
import { introSharedFields } from '../engine/candidate-steps.ts';
import type { CandidateOutputs } from '../engine/candidate-steps.ts';
import { sanitize } from '../runtime/tool.ts';
import { matchesFor, openingsForCandidate } from './match.ts';
import { compareOpenings, whyThisTarget } from './why.ts';
import {
  candidateEvidence, candidateView, confirmCandidate, getCandidateRow, insertCandidate, insertIntro, latestOpeningsRunId,
  listCandidateRows, listIntroRows, openingsSnapshot, reconsentCandidate, setCandidateRun, setIntroRun,
  companiesOf, companySummaries,
} from './store.ts';
import type { CandidateEdits, CandidateRow, IntroRow, OpeningsSnapshot } from './store.ts';

// The send-once proof's fault injection (scripts/send-once-proof.ts); /api/runs accepts the same flag.
type InjectedChaos = { crashAfterDeliver?: boolean };

export interface DeskDeps {
  store: Store;
  // Creates a run of the given pipeline and forks its engine worker; returns the run id.
  launch(pipeline: Pipeline, request: string, options?: {
    limits?: Partial<RunLimits>; dataMode?: 'live' | 'cache' | 'fixture'; chaos?: InjectedChaos;
  }): string;
}

const consentSchema = z.object({
  shareHistory: z.boolean(), shareSkills: z.boolean(), shareSamples: z.boolean(), discoverable: z.boolean(),
}).strict();
const confirmSchema = z.object({
  consent: consentSchema.optional(),
  roleFamily: z.enum(Object.keys(ROLE_FAMILY_LABELS) as [RoleFamily, ...RoleFamily[]]).nullable().optional(),
  skills: z.array(z.string().max(60)).max(40).optional(),
});
const candidateSchema = z.object({
  linkedinUrl: z.string().max(300),
  samples: z.array(z.string().max(2000)).max(5).optional(),
  consent: consentSchema,
  dataMode: z.enum(['live', 'cache', 'fixture']).optional(),
});
// One enrich call lists at 1-9 credits; cap the candidate run far below the 600 per-run ceiling.
const CANDIDATE_LIMITS: Partial<RunLimits> = { maxCredits: 25 };

const pick = (evidence: Evidence[], ids: Iterable<string>) => {
  const wanted = new Set(ids);
  return evidence.filter(row => wanted.has(row.id));
};
// Anti-wrapper rule 4: no bare scores leave the API. Ranking uses them internally; the UI shows clauses and fit reasons.
function publicOpening<T extends Opening>(opening: T): Omit<T, 'confidence' | 'matchScore'> {
  const { confidence: _confidence, matchScore: _matchScore, ...rest } = opening as T & { matchScore?: number };
  return rest;
}
function publicMatch({ score: _score, ...rest }: Match): Omit<Match, 'score'> {
  return rest;
}
const shortId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function deskRoutes({ store, launch }: DeskDeps) {
  const api = new Hono();

  const introView = (row: IntroRow): IntroRequest => {
    const snapshot = openingsSnapshot(store, row.openingsRunId);
    const opening = snapshot?.openings.find(item => item.id === row.openingId);
    const drafted = row.runId ? store.getOutput<CandidateOutputs['draft_intro']>(row.runId, 'draft_intro') : undefined;
    const approval = row.runId ? store.getApprovals(row.runId)[0] : undefined;
    const delivered = Boolean(row.runId && approval && store.getOutbox(row.runId).some(action => action.approvalId === approval.id));
    const received = approval && store.sql.prepare('SELECT received_at FROM inbox_received WHERE idempotency_key = ?')
      .get(approval.idempotencyKey) as { received_at: string } | undefined;
    const receipt = received ? { idempotencyKey: approval!.idempotencyKey, receivedAt: received.received_at } : null;
    const blocked = drafted?.draft?.status === 'not_drafted' ? drafted.draft.blockedReason ?? 'Not drafted' : null;
    const status: IntroRequest['status'] = blocked ? 'not_drafted' : delivered || receipt ? 'delivered' : approval?.status === 'rejected' ? 'declined'
      : approval?.status === 'pending' ? 'awaiting_approval' : 'new';
    return {
      id: row.id, direction: row.direction, candidateId: row.candidateId, companyId: row.companyId,
      companyName: opening?.companyName ?? drafted?.company.name ?? row.companyId, openingId: row.openingId,
      roleTitle: opening?.roleTitle ?? drafted?.roleTitle ?? '', message: drafted?.draft?.body ?? '', status, runId: row.runId,
      approvalId: approval?.id ?? null, evidenceIds: drafted?.draft?.citations.map(item => item.evidenceId) ?? [],
      citations: drafted?.draft?.citations.map(({ marker, evidenceId }) => ({ marker, evidenceId })) ?? [],
      unverifiable: drafted?.draft?.unverifiable ?? [], generatorLabel: drafted?.draft?.generatorLabel ?? null,
      subject: drafted?.draft?.subject ?? null,
      receipt, ...(blocked && { blockedReason: blocked }), receivedAt: receipt?.receivedAt ?? row.createdAt,
    };
  };

  const startIntro = (direction: IntroRow['direction'], candidate: Candidate, opening: Opening, snapshot: OpeningsSnapshot,
    chaos?: InjectedChaos) => {
    // One intro per direction, candidate and opening: a repeated request returns the existing one.
    const existing = listIntroRows(store, { candidateId: candidate.id })
      .find(row => row.direction === direction && row.openingId === opening.id && row.runId);
    if (existing) return { intro: introView(existing), created: false };
    const id = shortId('in');
    insertIntro(store, { id, direction, candidateId: candidate.id, companyId: opening.companyId, openingId: opening.id,
      openingsRunId: snapshot.runId });
    setIntroRun(store, id, launch('intro', `intro:${id}`, { chaos }));
    return { intro: introView(listIntroRows(store, { candidateId: candidate.id }).find(row => row.id === id)!), created: true };
  };

  const loadCandidate = (id: string) => {
    const row = getCandidateRow(store, id);
    return row ? candidateView(store, row) : undefined;
  };

  // ---------- openings ----------

  api.post('/openings/scan', async c => {
    const body = await c.req.json().catch(() => ({})) as { request?: string; replay?: { asOf?: string }; dataMode?: string; confirmLive?: boolean };
    // dataMode 'cache' replays a previous live scan from the tool cache (0 credits); 'fixture' uses fictional companies.
    const dataMode = body.dataMode === 'cache' || body.dataMode === 'fixture' || body.dataMode === 'live' ? body.dataMode : undefined;
    // A live scan can spend hundreds of credits on cache misses, so it never starts by accident (a script, a page load).
    if ((dataMode ?? config.dataMode) === 'live' && body.confirmLive !== true) {
      return c.json({ error: 'A live scan reads Crustdata and can spend 300–600 credits. Send dataMode "cache" to replay the ' +
        'recorded read for 0 credits, or confirmLive: true to read live.' }, 409);
    }
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(body.replay?.asOf ?? '') ? body.replay!.asOf : null;
    const request = (body.request?.trim() || 'Predict openings in inference, ML platform, MLOps and GPU/LLM infrastructure roles') +
      (asOf ? `, replay as of ${asOf}` : '');
    // A full cohort pull is 8–13 person-search pages paced for the rate limit (about 4 minutes and 300–600 credits).
    const runId = launch('openings', request, { dataMode, limits: { maxCredits: 1500, maxSeconds: asOf ? 1200 : 900 } });
    return c.json({ runId }, 201);
  });

  api.get('/openings/funnel', c => {
    const runId = latestOpeningsRunId(store);
    const funnel = runId ? store.getOutput<{ funnel?: OpeningsFunnel }>(runId, 'detect_openings')?.funnel : undefined;
    if (!funnel) return c.json({ error: 'No completed openings scan with a funnel yet' }, 404);
    return c.json(funnel);
  });

  // ---------- candidates ----------

  api.post('/candidates', async c => {
    const body = candidateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Expected linkedinUrl, consent {shareHistory, shareSkills, shareSamples, discoverable} and optional samples' }, 400);
    }
    const linkedinUrl = linkedinProfileUrl(body.data.linkedinUrl);
    if (!linkedinUrl) return c.json({ error: 'Expected a LinkedIn profile URL like https://www.linkedin.com/in/your-name/' }, 400);
    const consent = { ...body.data.consent, recordedAt: new Date().toISOString() };
    const samples = (body.data.samples ?? []).map(sample => String(sanitize(sample.trim(), true))).filter(Boolean);
    // One profile per data mode is one candidate: re-creating it returns the existing record (no copy, no second enrich)
    // with the consent just given, unless that record's profile read failed.
    const mode = body.data.dataMode ?? config.dataMode;
    const existing = listCandidateRows(store).filter(row => row.linkedinUrl === linkedinUrl && row.runId
      && store.getRun(row.runId)?.data_mode === mode && !['failed', 'crashed', 'budget_exhausted'].includes(store.getRun(row.runId)?.status ?? ''))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (existing) {
      reconsentCandidate(store, existing.id, consent, samples.length ? samples : existing.samples);
      return c.json({ candidateId: existing.id, runId: existing.runId, existing: true }, 200);
    }
    const candidateId = shortId('cand');
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
    const body = confirmSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Expected optional consent, roleFamily (a role family or null) and skills (strings)' }, 400);
    // Only a real change counts as a candidate edit, so unchanged fields keep their "parsed by" provenance.
    const { roleFamily, skills } = body.data;
    const edits: CandidateEdits = {};
    if (roleFamily !== undefined && roleFamily !== candidate.roleFamily) edits.roleFamily = roleFamily;
    const cleanSkills = skills && [...new Set(skills.map(skill => String(sanitize(skill.trim(), true))).filter(Boolean))].slice(0, 30);
    if (cleanSkills && cleanSkills.join('\n') !== candidate.skills.join('\n')) edits.skills = cleanSkills;
    confirmCandidate(store, id, body.data.consent, edits);
    const confirmed = loadCandidate(id)!;
    // Matching re-runs on the confirmed profile (edited family and skills, current consent).
    const snapshot = openingsSnapshot(store);
    const openings = snapshot ? openingsForCandidate(confirmed, snapshot.openings, snapshot.evidence).map(publicOpening) : [];
    return c.json({ ...confirmed, evidence: candidateEvidence(store, confirmed), openings });
  });

  api.get('/candidates/:id/openings', c => {
    const candidate = loadCandidate(c.req.param('id'));
    if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
    const snapshot = openingsSnapshot(store);
    if (candidate.status !== 'ready' || !snapshot) return c.json([]);
    const ranked: OpeningForCandidate[] = openingsForCandidate(candidate, snapshot.openings, snapshot.evidence);
    return c.json(ranked.map(publicOpening));
  });

  api.get('/candidates/:id/inbox', c => {
    const id = c.req.param('id');
    if (!getCandidateRow(store, id)) return c.json({ error: 'Candidate not found' }, 404);
    // Fed only by the send-once outbox: an intro appears here once the test-inbox receiver has accepted it.
    return c.json(listIntroRows(store, { candidateId: id }).filter(row => row.direction === 'company_to_candidate')
      .map(introView).filter(intro => intro.receipt));
  });

  api.get('/candidates/:id/intros/preview', c => {
    const candidate = loadCandidate(c.req.param('id'));
    if (!candidate) return c.json({ error: 'Candidate not found' }, 404);
    if (candidate.status !== 'ready') return c.json({ error: 'The profile is not ready yet' }, 409);
    const opening = openingsSnapshot(store)?.openings.find(item => item.id === c.req.query('openingId'));
    if (!opening) return c.json({ error: 'Opening not found in the latest scan' }, 404);
    const shared = introSharedFields(candidate, candidateEvidence(store, candidate));
    const preview: IntroPreview = {
      candidateId: candidate.id, openingId: opening.id, companyName: opening.companyName, roleTitle: opening.roleTitle,
      shared: [{ field: 'displayName', label: 'Name', value: candidate.displayName },
        ...shared.map(({ field, label, value, evidenceId }) => ({ field, label, value, evidenceId }))],
      withheld: [
        { field: 'fullName', label: 'Full name', reason: 'Never shared: first name and last initial only' },
        { field: 'contact', label: 'Email, phone, profile URL', reason: 'Never in the intro: replies go through the desk' },
        ...(!candidate.consent.shareSkills ? [{ field: 'skills', label: 'Skills', reason: 'You did not share skills' }] : []),
        ...(!candidate.consent.shareHistory ? [{ field: 'history', label: 'Work history', reason: 'You did not share work history' }] : []),
        ...(candidate.consent.shareHistory ? [{ field: 'pastRoles', label: 'Past roles', reason: 'Only the current role goes into an intro' }] : []),
        { field: 'samples', label: 'Work samples', reason: 'Not included in intros' },
        { field: 'headline', label: 'Headline', reason: 'Not included in intros' },
      ],
    };
    return c.json(preview);
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
    const body = z.object({ openingId: z.string().min(1), chaos: z.object({ crashAfterDeliver: z.boolean().optional() }).strict().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected openingId' }, 400);
    const snapshot = openingsSnapshot(store);
    const opening = snapshot?.openings.find(item => item.id === body.data.openingId);
    if (!snapshot || !opening) return c.json({ error: 'Opening not found in the latest scan' }, 404);
    if (opening.status === 'held') return c.json({ error: 'Held: not an opening' }, 409);
    const { intro, created } = startIntro('candidate_to_company', candidate, opening, snapshot, body.data.chaos);
    return c.json(intro, created ? 201 : 200);
  });

  // ---------- companies ----------

  api.get('/companies', c => {
    const snapshot = openingsSnapshot(store);
    return c.json(snapshot ? companySummaries(snapshot) : []);
  });

  api.get('/companies/:id', c => {
    const id = c.req.param('id');
    const snapshot = openingsSnapshot(store);
    // Accept the canonical id or a name slug ("abacus-ai" for Abacus.AI).
    const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const company = snapshot && companiesOf(snapshot).find(item => item.id === id || slug(item.name) === slug(id));
    if (!snapshot || !company) return c.json({ error: 'Company not found in the latest openings scan' }, 404);
    if (company.id !== id) return c.redirect(`/api/companies/${company.id}`, 302);
    const openings = snapshot.openings.filter(opening => opening.companyId === id).sort(compareOpenings);
    const summaries = companySummaries(snapshot);
    const departures = snapshot.departures.filter(departure => departure.companyId === id);
    // Earlier copies of the same profile (created before re-creates were deduplicated) show once: the copy with an intro
    // at this company, else the newest.
    const introFor = new Set(listIntroRows(store, { companyId: id }).map(row => row.candidateId));
    const byProfile = new Map<string, CandidateRow>();
    for (const row of listCandidateRows(store)) {
      const kept = byProfile.get(row.linkedinUrl);
      const better = !kept || (introFor.has(row.id) && !introFor.has(kept.id))
        || (introFor.has(row.id) === introFor.has(kept.id) && row.createdAt > kept.createdAt);
      if (better) byProfile.set(row.linkedinUrl, row);
    }
    const candidates = [...byProfile.values()].map(row => candidateView(store, row))
      .filter(candidate => candidate.status === 'ready' && candidate.consent.discoverable);
    const matches = candidates.flatMap(candidate => matchesFor(candidate, openings, snapshot.evidence)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const intros = listIntroRows(store, { companyId: id }).map(introView);
    const replayRun = latestOpeningsRunId(store, true);
    const replay = replayRun ? openingsSnapshot(store, replayRun)?.replay ?? null : null;
    const cited = [
      ...company.evidenceIds, ...openings.flatMap(opening => opening.evidenceIds), ...departures.map(departure => departure.evidenceId),
      ...matches.flatMap(match => match.fit.flatMap(reason => reason.evidenceId ?? [])),
    ];
    const view: CompanyView = {
      company, departures, openings: openings.map(opening => ({ ...publicOpening(opening), why: whyThisTarget(opening, snapshot.openings, summaries) })), matches: matches.map(publicMatch), intros, runId: snapshot.runId, replay,
      evidence: pick(snapshot.evidence, cited),
    };
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
