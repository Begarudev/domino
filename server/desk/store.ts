// Search Desk persistence: candidates and intro requests, plus read helpers over the openings / candidate / intro runs.
// Tables are created lazily (CREATE TABLE IF NOT EXISTS) on the shared store; the engine worker calls the same helpers.
import type { Company, Evidence } from '../../shared/types.ts';
import type { Candidate, Consent, Departure, IntroRequest, Opening } from '../../shared/desk.ts';
import { decode, now } from '../db.ts';
import type { Store } from '../db.ts';
import type { CandidateOutputs } from '../engine/candidate-steps.ts';
import type { OpeningsOutputs } from '../engine/openings-steps.ts';

const ready = new WeakSet<Store>();
export function deskTables(store: Store) {
  if (ready.has(store)) return;
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS desk_candidates (
      id TEXT PRIMARY KEY, run_id TEXT, linkedin_url TEXT NOT NULL, consent_json TEXT NOT NULL, samples_json TEXT NOT NULL,
      confirmed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desk_intros (
      id TEXT PRIMARY KEY, run_id TEXT, direction TEXT NOT NULL, candidate_id TEXT NOT NULL, company_id TEXT NOT NULL,
      opening_id TEXT NOT NULL, openings_run_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS desk_intros_candidate ON desk_intros (candidate_id);
    CREATE INDEX IF NOT EXISTS desk_intros_company ON desk_intros (company_id);
  `);
  ready.add(store);
}

export interface CandidateRow {
  id: string; runId: string | null; linkedinUrl: string; consent: Consent; samples: string[]; confirmedAt: string | null; createdAt: string;
}
export interface IntroRow {
  id: string; runId: string | null; direction: IntroRequest['direction']; candidateId: string; companyId: string;
  openingId: string; openingsRunId: string; createdAt: string;
}

const candidateRow = (row: Record<string, unknown>): CandidateRow => ({
  id: row.id as string, runId: row.run_id as string | null, linkedinUrl: row.linkedin_url as string,
  consent: decode<Consent>(row.consent_json as string), samples: decode<string[]>(row.samples_json as string),
  confirmedAt: row.confirmed_at as string | null, createdAt: row.created_at as string,
});
const introRow = (row: Record<string, unknown>): IntroRow => ({
  id: row.id as string, runId: row.run_id as string | null, direction: row.direction as IntroRow['direction'],
  candidateId: row.candidate_id as string, companyId: row.company_id as string, openingId: row.opening_id as string,
  openingsRunId: row.openings_run_id as string, createdAt: row.created_at as string,
});

export function insertCandidate(store: Store, row: Omit<CandidateRow, 'runId' | 'confirmedAt' | 'createdAt'>) {
  deskTables(store);
  // Samples are stored only with consent.
  store.sql.prepare(`INSERT INTO desk_candidates (id, linkedin_url, consent_json, samples_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, row.linkedinUrl, JSON.stringify(row.consent), JSON.stringify(row.consent.shareSamples ? row.samples : []), now());
}
export function setCandidateRun(store: Store, id: string, runId: string) {
  deskTables(store);
  store.sql.prepare('UPDATE desk_candidates SET run_id = ? WHERE id = ?').run(runId, id);
}
export function getCandidateRow(store: Store, id: string): CandidateRow | undefined {
  deskTables(store);
  const row = store.sql.prepare('SELECT * FROM desk_candidates WHERE id = ?').get(id);
  return row ? candidateRow(row) : undefined;
}
export function confirmCandidate(store: Store, id: string, consent: Consent | undefined) {
  deskTables(store);
  const row = getCandidateRow(store, id)!;
  const next = consent ? { ...consent, recordedAt: now() } : row.consent;
  // Withdrawing sample consent deletes the stored samples; re-granting cannot restore them.
  store.sql.prepare('UPDATE desk_candidates SET confirmed_at = ?, consent_json = ?, samples_json = ? WHERE id = ?')
    .run(now(), JSON.stringify(next), JSON.stringify(next.shareSamples ? row.samples : []), id);
}
export function listCandidateRows(store: Store): CandidateRow[] {
  deskTables(store);
  return store.sql.prepare('SELECT * FROM desk_candidates ORDER BY created_at').all().map(candidateRow);
}

export function insertIntro(store: Store, row: Omit<IntroRow, 'runId' | 'createdAt'>) {
  deskTables(store);
  store.sql.prepare(`INSERT INTO desk_intros (id, direction, candidate_id, company_id, opening_id, openings_run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.direction, row.candidateId, row.companyId, row.openingId, row.openingsRunId, now());
}
export function setIntroRun(store: Store, id: string, runId: string) {
  deskTables(store);
  store.sql.prepare('UPDATE desk_intros SET run_id = ? WHERE id = ?').run(runId, id);
}
export function getIntroRow(store: Store, id: string): IntroRow | undefined {
  deskTables(store);
  const row = store.sql.prepare('SELECT * FROM desk_intros WHERE id = ?').get(id);
  return row ? introRow(row) : undefined;
}
export function listIntroRows(store: Store, by: { candidateId?: string; companyId?: string }): IntroRow[] {
  deskTables(store);
  const [column, value] = by.candidateId ? ['candidate_id', by.candidateId] : ['company_id', by.companyId ?? ''];
  return store.sql.prepare(`SELECT * FROM desk_intros WHERE ${column} = ? ORDER BY created_at DESC`).all(value).map(introRow);
}

// ---------- openings (owned by the openings pipeline; read-only here) ----------

export interface OpeningsSnapshot {
  runId: string;
  openings: Opening[];
  departures: Departure[];
  companies: Company[];
  evidence: Evidence[];
  replay: OpeningsOutputs['score_openings'] | null;
}

export function latestOpeningsRunId(store: Store, replay = false): string | null {
  // Live scans have no score_openings output; replay scans do. Pick the newest completed run of the wanted kind.
  const rows = store.sql.prepare(`SELECT runs.id FROM runs WHERE pipeline = 'openings' AND status = 'completed'
    ORDER BY created_at DESC, rowid DESC LIMIT 20`).all() as { id: string }[];
  const row = rows.find(({ id }) => Boolean(store.getOutput(id, 'score_openings')) === replay
    && Boolean(store.getOutput(id, 'detect_openings')));
  return row?.id ?? null;
}

export function openingsSnapshot(store: Store, runId = latestOpeningsRunId(store)): OpeningsSnapshot | null {
  if (!runId) return null;
  const detected = store.getOutput<OpeningsOutputs['detect_openings']>(runId, 'detect_openings');
  if (!detected) return null;
  const resolved = store.getOutput<OpeningsOutputs['resolve_departures']>(runId, 'resolve_departures');
  return {
    runId, openings: detected.openings, departures: resolved?.departures ?? [], companies: resolved?.companies ?? [],
    evidence: store.getEvidence(runId), replay: store.getOutput<OpeningsOutputs['score_openings']>(runId, 'score_openings') ?? null,
  };
}

// ---------- candidate view ----------

const failedStatuses = new Set(['failed', 'crashed', 'budget_exhausted']);

export function candidateView(store: Store, row: CandidateRow): Candidate {
  const runId = row.runId ?? '';
  const run = runId ? store.getRun(runId) : undefined;
  const fetched = runId ? store.getOutput<CandidateOutputs['fetch_profile']>(runId, 'fetch_profile') : undefined;
  const parsed = runId ? store.getOutput<CandidateOutputs['parse_profile']>(runId, 'parse_profile') : undefined;
  const status: Candidate['status'] = parsed && fetched?.found ? 'ready'
    : (fetched && !fetched.found) || (run && failedStatuses.has(run.status)) ? 'failed' : 'enriching';
  const { consent } = row;
  return {
    id: row.id, status, linkedinUrl: row.linkedinUrl,
    displayName: parsed?.displayName || 'Candidate', headline: parsed?.headline ?? null, roleFamily: parsed?.roleFamily ?? null,
    skills: consent.shareSkills ? parsed?.skills ?? [] : [],
    history: consent.shareHistory ? parsed?.history ?? [] : [],
    samples: consent.shareSamples ? row.samples : [],
    consent, confirmedAt: row.confirmedAt,
    evidenceIds: (fetched?.evidence ?? []).filter(evidence => consentedField(evidence, consent)).map(evidence => evidence.id),
    runId, parsedBy: parsed?.parsedBy ?? 'rules', ...(parsed?.fieldSource && { fieldSource: parsed.fieldSource }),
    ...(fetched?.evidence.some(evidence => evidence.mode === 'fixture') && { fixture: true }),
  };
}

export function consentedField(evidence: Evidence, consent: Consent) {
  const field = evidence.source.field ?? '';
  if (field.startsWith('experience.')) return consent.shareHistory;
  if (field.startsWith('skills.')) return consent.shareSkills;
  return true;
}

export function candidateEvidence(store: Store, candidate: Candidate): Evidence[] {
  const ids = new Set(candidate.evidenceIds);
  return candidate.runId ? store.getEvidence(candidate.runId).filter(row => ids.has(row.id)) : [];
}
