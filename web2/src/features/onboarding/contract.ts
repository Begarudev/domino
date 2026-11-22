// The parts of the desk-api contract (origin/desk-api shared/desk.ts) this feature reads before that branch merges:
// field source, rule clauses, intro preview and receipts. Mirrors the shapes; delete once shared/desk.ts has them.
import { isFixtureId, ROLE_FAMILY_LABELS, tryJson } from '../../data/desk.ts';
import type { Candidate, Consent, IntroRequest, Opening, RoleFamily, Sourced } from '../../data/desk.ts';
import { deskApi } from '../../data/query.ts';
import { runStore } from '../../data/store.ts';

export interface RuleClause {
  id: string;
  text: string;
  state: 'met' | 'open' | 'failed' | 'cant_verify';
  detail?: string;
  evidenceIds: string[];
}
export interface IntroPreviewField { field: string; label: string; value: string; evidenceId?: string }
export interface IntroPreview {
  candidateId: string; openingId: string; companyName: string; roleTitle: string;
  shared: IntroPreviewField[];
  withheld: { field: string; label: string; reason: string }[];
}
export type CandidateX = Candidate & { fieldSource?: string };
export type OpeningX = Opening & { clauses?: RuleClause[] };
export type IntroX = IntroRequest & { receipt?: { idempotencyKey: string; receivedAt: string } | null };

const live = () => runStore.get().mode === 'live';

/** null when there's no live answer (offline mode, a fixture row, endpoint not built): the caller uses its labelled fallback. */
const liveJson = <T>(ids: string[], url: string, init?: RequestInit) =>
  (live() && !ids.some(isFixtureId) ? tryJson<T>(url, init) : Promise.resolve(null));

export const fieldSourceText = (c: CandidateX) =>
  c.fieldSource ?? (c.parsedBy === 'llm' ? 'Filled by GPT-6 Luna · confirm each field' : 'Read by rules from your profile · confirm each field');

/** Confirm with the candidate's edits. The server stores consent today; roleFamily and skills ride along for desk-api. */
export async function confirmProfile(c: CandidateX, consent: Consent, edits: { roleFamily: RoleFamily | null; skills: string[] }, fixtureApi: typeof deskApi) {
  if (fixtureApi !== deskApi) return (await fixtureApi.confirmCandidate(c.id, consent)).data;
  const r = await liveJson<CandidateX>([c.id], `/api/candidates/${c.id}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent, ...edits }),
  });
  if (r) return (r as CandidateX & { candidate?: CandidateX }).candidate ?? r;
  return (await deskApi.confirmCandidate(c.id, consent)).data;
}

/** The candidate's own requests (GET /intros); before that endpoint exists, the fixture's candidate→company rows. */
export async function myIntros(candidateId: string): Promise<Sourced<IntroX[]>> {
  const r = await liveJson<IntroX[]>([candidateId], `/api/candidates/${candidateId}/intros`);
  if (r) return { data: r, source: 'live', evidence: [] };
  const fx = await deskApi.candidateInbox(candidateId);
  return { ...fx, data: (fx.data as IntroX[]).filter((x) => x.direction === 'candidate_to_company') };
}

/** Exactly what an intro would share. Without the endpoint, built from the consented fields. */
export async function introPreview(c: CandidateX, o: Opening): Promise<IntroPreview> {
  const r = await liveJson<IntroPreview>([c.id, o.id], `/api/candidates/${c.id}/intros/preview?openingId=${encodeURIComponent(o.id)}`);
  if (r) return r;
  const current = c.history.find((h) => !h.to) ?? c.history[0];
  const shared: IntroPreviewField[] = [{ field: 'displayName', label: 'Name', value: c.displayName }];
  if (c.roleFamily) shared.push({ field: 'roleFamily', label: 'Role family', value: ROLE_FAMILY_LABELS[c.roleFamily] });
  if (c.consent.shareSkills && c.skills.length) shared.push({ field: 'skills', label: 'Skills', value: c.skills.join(', ') });
  if (c.consent.shareHistory && current) shared.push({ field: 'currentRole', label: 'Current role', value: `${current.title}, ${current.company}` });
  return {
    candidateId: c.id, openingId: o.id, companyName: o.companyName, roleTitle: o.roleTitle, shared,
    withheld: [
      { field: 'fullName', label: 'Full name', reason: 'Never shared: first name and last initial only' },
      { field: 'contact', label: 'Email, phone, profile URL', reason: 'Never in the intro' },
      ...(!c.consent.shareSkills ? [{ field: 'skills', label: 'Skills', reason: 'You didn’t share skills' }] : []),
      ...(!c.consent.shareHistory ? [{ field: 'history', label: 'Work history', reason: 'You didn’t share work history' }] : []),
      { field: 'samples', label: 'Work samples', reason: 'Not included in intros' },
    ],
  };
}
