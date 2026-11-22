// Candidate and intro pipelines (Search Desk). OWNER: domino-desk-api. Contract: shared/desk.ts + docs/CONTRACT.md.
// candidate: fetch_profile (live person enrich of the candidate's own, consented profile) -> parse_profile (LLM with a
// rules fallback) -> match_openings (vs the latest completed openings scan).
// intro: draft_intro (sourced draft through the shared verifier) -> intro_gate (one approval; the existing outbox +
// receiver deliver it once to the test inbox).
import { z } from 'zod';
import type { Approval, Company, Draft, Evidence, SourceItem, Target } from '../../shared/types.ts';
import { ROLE_FAMILY_LABELS } from '../../shared/desk.ts';
import type { Candidate, CandidateHistoryItem, IntroRequest, Match, Opening, RoleFamily } from '../../shared/desk.ts';
import { now } from '../db.ts';
import { enrichFixture, personEnrich } from '../crustdata/person-enrich.ts';
import type { EnrichInput } from '../crustdata/person-enrich.ts';
import { candidateView, getCandidateRow, getIntroRow, openingsSnapshot } from '../desk/store.ts';
import { classifyProfile, matchesFor, ROLE_FAMILIES } from '../desk/match.ts';
import type { Claim, PersonMention } from '../domain/types.ts';
import { article, drainWindow, monthInterval } from '../domain/openings.ts';
import { modelClient } from '../llm/client.ts';
import { BudgetError, hash, ToolContext } from '../runtime/tool.ts';
import type { CrustReadMeta } from '../runtime/tool.ts';
import * as deps from './deps.ts';
import type { Runner } from './steps.ts';

export type ParsedProfile = Pick<Candidate, 'displayName' | 'headline' | 'roleFamily' | 'skills' | 'history' | 'parsedBy' | 'fieldSource'>;
// The LLM is labelled wherever its output is shown (anti-wrapper rule 3).
const modelLabel = (model: string) => /gpt-6-luna/i.test(model) ? 'GPT-6 Luna' : model;
export const llmFieldSource = (model: string) => `Filled by ${modelLabel(model)} · confirm each field`;
export const RULES_FIELD_SOURCE = 'Read by rules from your profile · confirm each field';
export interface IntroDraft {
  introId: string;
  direction: IntroRequest['direction'];
  draft: Draft | null;
  company: Company;                 // the hiring company the opening is at
  recipient: string;                // "Hiring team" (candidate -> company) or the candidate's display name
  need: string;                     // the role family noun, e.g. "ML platform engineer"
  roleTitle: string;
  evidence: Evidence[];             // every row the draft cites (from the openings and candidate runs)
}
export interface CandidateOutputs {
  fetch_profile: { found: boolean; evidence: Evidence[]; person: PersonMention | null };
  parse_profile: ParsedProfile;
  match_openings: { matches: Match[]; openingsRunId: string | null };
  draft_intro: IntroDraft;
  intro_gate: Approval[];
}

const today = () => new Date().toISOString().slice(0, 10);
const SKILLS_FIELD = 'skills.professional_network_skills';

// The run request carries only an opaque id ("candidate:cand_x" / "intro:in_x"), never the profile URL. The row is
// written before launch, but wait briefly in case a worker ever races it.
async function rowFor<T>(ctx: ToolContext, prefix: string, read: (id: string) => T | undefined): Promise<T> {
  const id = ctx.store.requireRun(ctx.runId).request.match(new RegExp(`^${prefix}:(\\S+)`))?.[1];
  if (!id) throw new Error(`Run request does not name a ${prefix}`);
  for (let attempt = 0; attempt < 30; attempt++) {
    const row = read(id);
    if (row) return row;
    await ctx.wait(100);
  }
  throw new Error(`${prefix} ${id} was not found`);
}

function enrichEvent(ctx: ToolContext, observation: CrustReadMeta, input: EnrichInput, person: PersonMention | null,
  evidence: Evidence[]) {
  const shared = ['headline', 'title', input.shareSkills && 'skills', input.shareHistory && 'work history'].filter(Boolean).join(', ');
  const items: SourceItem[] = person ? [
    { kind: 'company', title: `${person.name}: ${person.title || 'profile'}`, company: null, url: input.profileUrl,
      date: today(), precision: 'day', signal: 'Candidate profile (opted in)', matched: true },
    ...person.pastEmployers.map((role): SourceItem => ({
      kind: 'company', title: role.title ?? 'Role', company: role.name, url: null, date: role.from ?? null,
      precision: role.from ? 'month' : null, signal: role.to ? 'Past role' : 'Current role', matched: true,
    })),
  ] : [];
  ctx.store.recordEvent(ctx.runId, {
    type: 'source.read', callId: observation.callId, step: 'fetch_profile', endpoint: personEnrich.name, mode: observation.mode,
    query: `Candidate's own profile, consented fields: ${shared}`, totalAvailable: person ? 1 : 0, items: items.slice(0, 12),
  });
  const fresh = evidence.filter(row => !ctx.store.findEvidence(row.id));
  for (const row of fresh) {
    ctx.store.saveEvidenceSource(row.id, { endpoint: personEnrich.name, path: personEnrich.path, input, rawId: row.id,
      time: { asOf: today(), windowDays: 0 } });
  }
  if (fresh.length) ctx.store.recordEvent(ctx.runId, { type: 'evidence.added', evidence: fresh });
}

async function fetchProfile(ctx: ToolContext) {
  const row = await rowFor(ctx, 'candidate', id => getCandidateRow(ctx.store, id));
  const input: EnrichInput = { profileUrl: row.linkedinUrl, shareHistory: row.consent.shareHistory, shareSkills: row.consent.shareSkills };
  let observation: CrustReadMeta | undefined;
  const result = await ctx.crust(personEnrich, input, { asOf: today(), windowDays: 0 },
    (path, body) => path === personEnrich.path ? enrichFixture(body) : deps.fixtureFor(path, body),
    () => ({ evidence: [], people: [] }), read => { observation = read; });
  // Scope evidence ids to this run (the same profile can be onboarded twice).
  const suffix = hash(ctx.runId).slice(0, 16);
  const ids = new Map(result.evidence.map(row => [row.id, `${row.id.slice(0, 19)}${suffix}`]));
  const evidence = result.evidence.map(row => ({ ...row, id: ids.get(row.id)! }));
  const raw = result.people[0];
  const person = raw ? { ...raw, evidenceIds: raw.evidenceIds.flatMap(id => ids.get(id) ?? []) } : null;
  ctx.store.transaction(() => { if (observation) enrichEvent(ctx, observation, input, person, evidence); });
  const output: CandidateOutputs['fetch_profile'] = { found: Boolean(person), evidence, person };
  return {
    output,
    summary: person ? `Profile read for ${person.name} (${evidence.length} consented fields)` : 'No public profile found for that URL',
  };
}

const llmProfile = z.object({
  roleFamily: z.enum(ROLE_FAMILIES as [RoleFamily, ...RoleFamily[]]).nullable(),
  skills: z.array(z.string()).max(40).default([]),
});

async function parseProfile(ctx: ToolContext, c: Partial<CandidateOutputs>): Promise<{ output: ParsedProfile; summary: string }> {
  const fetched = c.fetch_profile!;
  const person = fetched.person;
  if (!fetched.found || !person) {
    return { output: { displayName: 'Candidate', headline: null, roleFamily: null, skills: [], history: [], parsedBy: 'rules' },
      summary: 'Nothing to parse: the profile was not found' };
  }
  const field = (name: string) => fetched.evidence.find(row => row.source.field === name)?.value;
  const headlineValue = field('basic_profile.headline');
  const headline = typeof headlineValue === 'string' ? headlineValue : null;
  const title = person.title || null;
  const skills = String(field(SKILLS_FIELD) ?? '').split('; ').filter(Boolean);
  const history: CandidateHistoryItem[] = person.pastEmployers.map(role => ({
    company: role.name, companyId: null, title: role.title ?? '', from: role.from ?? null, to: role.to ?? null,
  }));
  const base = { displayName: person.name, headline, skills, history };
  const source = [title, headline, ...skills, ...history.map(item => item.title)].filter(Boolean).join(' | ').toLowerCase();
  const label = (family: RoleFamily | null) => family ? ROLE_FAMILY_LABELS[family] : 'no tracked role family';
  try {
    const completion = await modelClient(ctx).complete({
      purpose: 'parse', json: true, maxTokens: 600,
      system: 'Classify a job candidate from their own consented profile fields. Return {"roleFamily": one of ' +
        ROLE_FAMILIES.join(', ') + ' or null, "skills": the candidate\'s technical skills, copied verbatim from the input}. ' +
        'Families: ' + Object.entries(ROLE_FAMILY_LABELS).map(([key, text]) => `${key} = ${text}`).join('; ') + '. Do not invent skills.',
      user: JSON.stringify({ title, headline, skills, history: history.map(item => item.title) }),
    });
    const parsed = completion ? llmProfile.safeParse(JSON.parse(completion.text)) : null;
    if (completion && parsed?.success) {
      // Keep only skills that appear in the source fields, so every skill stays traceable to the profile.
      const grounded = [...new Set(parsed.data.skills.map(skill => skill.trim()).filter(skill => skill && source.includes(skill.toLowerCase())))];
      const roleFamily = parsed.data.roleFamily ?? classifyProfile(title, headline, skills);
      const fieldSource = llmFieldSource(completion.model);
      return { output: { ...base, skills: grounded.length ? grounded : skills, roleFamily, parsedBy: 'llm', fieldSource },
        summary: `${fieldSource} (read as ${label(roleFamily)})` };
    }
  } catch (error) {
    if (error instanceof BudgetError || ctx.signal?.aborted) throw error;
  }
  const roleFamily = classifyProfile(title, headline, skills);
  return { output: { ...base, roleFamily, parsedBy: 'rules', fieldSource: RULES_FIELD_SOURCE },
    summary: `${RULES_FIELD_SOURCE} (read as ${label(roleFamily)})` };
}

async function matchOpenings(ctx: ToolContext) {
  const row = await rowFor(ctx, 'candidate', id => getCandidateRow(ctx.store, id));
  const candidate = candidateView(ctx.store, { ...row, runId: ctx.runId });
  const snapshot = openingsSnapshot(ctx.store);
  const output: CandidateOutputs['match_openings'] = { matches: [], openingsRunId: null };
  if (!snapshot) return { output, summary: 'No completed openings scan to match against yet' };
  // Ranked internally; the stored output carries no bare score (anti-wrapper rule 4).
  output.matches = matchesFor(candidate, snapshot.openings, snapshot.evidence).map(({ score: _score, ...match }) => match);
  output.openingsRunId = snapshot.runId;
  const n = output.matches.length;
  return { output, summary: `${n} predicted opening${n === 1 ? '' : 's'} fit this profile` };
}

// ---------- intro ----------

// Mirrors the verifier's number/date tokenizer so each claim lists exactly the tokens its sentence may contain.
const numberPattern = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?\b|\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\b|[$€₹£]?\d+(?:[,.:]\d+)*(?:%|[kmb]\b)?/gi;
const familyNoun: Record<RoleFamily, string> = {
  inference: 'Inference engineer', ml_platform: 'ML platform engineer', mlops: 'MLOps engineer',
  gpu_llm_infra: 'GPU / LLM infrastructure engineer', backend_payments: 'Backend / payments engineer',
};
// "an ML Platform Engineer", "an Inference engineer", "a GPU engineer": acronyms take the article of their spoken letter.
const monthOf = (date: string | null) => date
  ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : null;

// Exactly the candidate fields an intro message carries, given consent. The preview route and the draft share this.
export interface SharedField { field: string; label: string; value: string; evidenceId: string; claim: string }
export function introSharedFields(candidate: Candidate, candidateEvidence: Evidence[]): SharedField[] {
  const fields: SharedField[] = [];
  const name = candidate.displayName;
  const title = candidateEvidence.find(row => row.source.field === 'basic_profile.current_title');
  if (title) fields.push({ field: 'title', label: 'Current title', value: String(title.value), evidenceId: title.id,
    claim: `${name} lists the current title ${title.value}` });
  const skills = candidateEvidence.find(row => row.source.field === SKILLS_FIELD);
  // Cite only skills the enriched row actually lists; skills the candidate added are not sourced facts.
  const sourced = skills ? candidate.skills.filter(skill => String(skills.value).split('; ').includes(skill)) : [];
  if (candidate.consent.shareSkills && skills && sourced.length) {
    const top = sourced.slice(0, 3).join(', ');
    fields.push({ field: 'skills', label: 'Skills (top 3)', value: top, evidenceId: skills.id, claim: `${name} lists skills including ${top}` });
  }
  const current = candidate.consent.shareHistory ? candidate.history.find(item => item.to === null) : undefined;
  const role = current && candidateEvidence.find(row => row.source.field?.startsWith('experience.employment_details.current'));
  if (current && role) {
    const since = monthOf(current.from) ?? 'recently';
    fields.push({ field: 'history', label: 'Current role', value: `${current.title} at ${current.company} since ${since}`, evidenceId: role.id,
      claim: `${name} has worked as ${current.title} at ${current.company} since ${since}` });
  }
  return fields;
}

// Claims avoid "left"/"departures" wording on purpose: the shared verifier strikes it (tactless to a hiring team).
export function introClaims(opening: Opening, candidate: Candidate, candidateEvidence: Evidence[], evidence: Map<string, Evidence>): Claim[] {
  const claims: Claim[] = [];
  const add = (text: string, evidenceIds: string[], reason?: string) => claims.push({
    n: claims.length + 1, text, evidenceIds, numbers: [...new Set(text.match(numberPattern) ?? [])],
    verifiable: evidenceIds.length > 0 && evidenceIds.every(id => Boolean(evidence.get(id)?.verifiable && evidence.get(id)?.observedAt)),
    ...(reason && { reason }),
  });
  // Only conclusive departures are cited: a month that straddles the 90-day window start (an August move read on
  // 22 Nov) is shown on the opening but never offered as a fact in an intro.
  const drainReasons = opening.reasons.filter(reason => reason.kind === 'talent_drain'
    && (!reason.date || drainWindow(monthInterval(reason.date), opening.predictedAt) === 'inside'));
  const drainIds = [...new Set(drainReasons.flatMap(reason => reason.evidenceId ?? []))];
  const drainMonth = monthOf(drainReasons[0]?.date ?? null);
  const family = ROLE_FAMILY_LABELS[opening.roleFamily];
  const after = drainMonth ? ` after ${family} team changes in ${drainMonth}` : '';
  // A watch is not a prediction (rule O1 needs 2 departures and a settled gap); the claim says so.
  add(opening.status === 'watch'
    ? `DOMINO is watching ${opening.companyName} for a possible ${opening.roleTitle} opening${after}`
    : `DOMINO predicts ${article(opening.roleTitle)} ${opening.roleTitle} opening at ${opening.companyName}${after}`,
  drainIds.length ? drainIds : opening.evidenceIds);
  // The no-replacement claim names exactly the checks it cites: the job search, the person (hire) search, or both.
  const gap = opening.reasons.find(reason => reason.kind === 'no_replacement');
  const checkIds = (id: string) => (opening.clauses ?? []).find(clause => clause.id === id)?.evidenceIds ?? [];
  const jobIds = checkIds('o1.no_replacement.jobs');
  const hireIds = checkIds('o1.no_replacement.people');
  if (gap) {
    const cited = [...new Set([...jobIds, ...hireIds])];
    const what = jobIds.length && hireIds.length ? 'job post or hire' : hireIds.length ? 'hire' : jobIds.length ? 'job post' : 'job post or hire';
    const ids = cited.length ? cited : gap.evidenceId ? [gap.evidenceId] : [];
    add(`No ${family} ${what} at ${opening.companyName} has been found since then`, ids,
      ids.length ? undefined : 'The no-replacement check has no dated source record.');
  }
  for (const shared of introSharedFields(candidate, candidateEvidence)) add(shared.claim, [shared.evidenceId]);
  return claims;
}

type OutboundGate = (draft: Draft, target: Target, evidence: Evidence[]) => { reason: string; have: number; need: number } | null;
const MIN_OPENING_FACTS = 1;

// An intro is sent only if the outbound gate passes (>= 2 verified, dated, cited facts and a named role) AND at least
// one of those facts is about the opening; otherwise it would be a profile with no reason to reach out.
// The reason lists every missing item: "Not sent: not enough verified evidence (1 of 2 verified facts, 0 of 1 about
// the opening); missing: 1 more verified, dated, cited fact, a verified, dated fact about the opening".
export function introSendGate(draft: Draft, roleTitle: string, evidence: Evidence[], openingEvidenceIds: Set<string>,
  outboundGate: OutboundGate): { reason: string; missing: string[] } | null {
  const rows = new Map(evidence.map(row => [row.id, row]));
  const factIds = new Set(draft.citations.filter(cite => {
    const row = rows.get(cite.evidenceId);
    return Boolean(row?.verifiable && row.observedAt && draft.body.includes(`[${cite.marker}]`));
  }).map(cite => cite.evidenceId));
  const openingFacts = [...factIds].filter(id => openingEvidenceIds.has(id)).length;
  const role = { decider: { personId: '', name: roleTitle, title: roleTitle, reason: 'Intro role', evidenceIds: [] } } as unknown as Target;
  const outbound = outboundGate(draft, role, evidence);
  const need = outbound?.need ?? 2;
  const have = outbound?.have ?? factIds.size;
  const missing = [
    ...(have < need ? [`${need - have} more verified, dated, cited fact${need - have === 1 ? '' : 's'}`] : []),
    ...(openingFacts < MIN_OPENING_FACTS ? ['a verified, dated fact about the opening'] : []),
    ...(!roleTitle.trim() || (outbound && have >= need) ? ['a named role'] : []),
  ];
  if (!missing.length) return null;
  const counts = [
    ...(have < need || openingFacts >= MIN_OPENING_FACTS ? [`${have} of ${need} verified facts`] : []),
    ...(openingFacts < MIN_OPENING_FACTS ? [`${openingFacts} of ${MIN_OPENING_FACTS} about the opening`] : []),
  ];
  return { reason: `Not sent: not enough verified evidence (${counts.join(', ')}); missing: ${missing.join(', ')}`, missing };
}

async function draftIntro(ctx: ToolContext) {
  const intro = await rowFor(ctx, 'intro', id => getIntroRow(ctx.store, id));
  const row = getCandidateRow(ctx.store, intro.candidateId);
  const snapshot = openingsSnapshot(ctx.store, intro.openingsRunId);
  const opening = snapshot?.openings.find(item => item.id === intro.openingId);
  if (!row || !snapshot || !opening) throw new Error('The intro no longer has its candidate or opening');
  const candidate = candidateView(ctx.store, row);
  const ids = new Set(candidate.evidenceIds);
  const candidateRows = candidate.runId ? ctx.store.getEvidence(candidate.runId).filter(item => ids.has(item.id)) : [];
  const evidence = new Map([...snapshot.evidence, ...candidateRows].map(item => [item.id, item]));
  const claims = introClaims(opening, candidate, candidateRows, evidence);
  const company: Company = snapshot.companies.find(item => item.id === opening.companyId)
    ?? { id: opening.companyId, name: opening.companyName, aliases: [], evidenceIds: [] };
  const toCompany = intro.direction === 'candidate_to_company';
  const subject = toCompany ? `Intro: ${candidate.displayName} for ${opening.roleTitle}` : `${opening.companyName}: ${opening.roleTitle}`;
  const checked = deps.verifyDraft({ subject, body: claims.map(item => `${item.text} [${item.n}].`).join(' ') }, claims, [...evidence.values()]);
  const greeting = toCompany ? `Hello ${opening.companyName} hiring team,` : `Hello ${candidate.displayName},`;
  const cta = toCompany ? `${candidate.displayName} opted in and asked for this introduction. Reply to accept and we will connect you.`
    : `${opening.companyName} would like an introduction. Reply to accept; your contact details stay private until you do.`;
  const signoff = 'DOMINO (test mode)';
  const frame = (sentence: string) => ({ sentence, status: 'no_claim' as const, evidenceIds: [] });
  const draft: Draft = {
    id: `dr_${hash([ctx.runId, intro.id, checked.body].join('|')).slice(0, 16)}`, companyId: opening.companyId, personId: null, subject,
    ...checked, body: [greeting, checked.body, cta, signoff].filter(Boolean).join('\n\n'),
    checks: [frame(greeting), ...checked.checks, frame(cta), frame(signoff)],
    generator: 'template', verified: checked.verified && checked.body.trim().length > 0,
    meeting: { title: `Intro: ${opening.roleTitle}`, durationMin: 20, proposedSlots: [] },
  };
  // Same gate as outbound (steps.ts draftGate), plus a verified fact about the opening. Loaded lazily: steps.ts
  // imports this module, so a static import would be circular.
  const { draftGate } = await import('./steps.ts');
  const gate = introSendGate(draft, opening.roleTitle, [...evidence.values()], new Set(snapshot.evidence.map(item => item.id)), draftGate);
  draft.status = gate ? 'not_drafted' : 'ready';
  draft.blockedReason = gate?.reason ?? null;
  const cited = new Set(draft.citations.map(item => item.evidenceId));
  const removed = checked.checks.filter(item => item.status === 'removed').length;
  const output: IntroDraft = {
    introId: intro.id, direction: intro.direction, draft, company, recipient: toCompany ? 'Hiring team' : candidate.displayName,
    need: familyNoun[opening.roleFamily], roleTitle: opening.roleTitle, evidence: [...evidence.values()].filter(item => cited.has(item.id)),
  };
  if (gate) return { output, summary: gate.reason };
  return {
    output,
    summary: `Intro drafted with ${draft.citations.length} citations` +
      (removed ? `, ${removed} uncited sentence${removed === 1 ? '' : 's'} removed` : '') +
      (draft.unverifiable.length ? `, ${draft.unverifiable.length} I can't verify` : ''),
  };
}

function introGate(ctx: ToolContext, c: Partial<CandidateOutputs>) {
  const { draft, introId } = c.draft_intro!;
  const output: Approval[] = [];
  if (draft?.verified && draft.status !== 'not_drafted') {
    const idempotencyKey = hash([ctx.runId, introId, draft.body, 'send_message'].join('|')).slice(0, 16);
    output.push({ id: `ap_${idempotencyKey}`, runId: ctx.runId, companyId: draft.companyId, draftId: draft.id, kind: 'send_message',
      status: 'pending', idempotencyKey, createdAt: now() });
  }
  return { output, summary: output.length ? 'Intro ready for approval (test inbox only)' : draft?.blockedReason ?? 'No verified intro to send',
    events: output.map(approval => ({ type: 'approval.requested' as const, approval })) };
}

export const candidateSteps: { [K in keyof CandidateOutputs]: Runner<K> } = {
  fetch_profile: ctx => fetchProfile(ctx),
  parse_profile: (ctx, c) => parseProfile(ctx, c),
  match_openings: ctx => matchOpenings(ctx),
  draft_intro: ctx => draftIntro(ctx),
  intro_gate: (ctx, c) => introGate(ctx, c),
};
