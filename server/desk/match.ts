// Role-family classification and candidate <-> opening matching. Pure functions; every FitReason either cites a
// consented candidate profile field (profileField) or an opening evidence id, else it is 'cant_verify'.
import type { Evidence } from '../../shared/types.ts';
import { ROLE_FAMILY_LABELS } from '../../shared/desk.ts';
import type { Candidate, FitReason, Match, Opening, OpeningForCandidate, RoleFamily } from '../../shared/desk.ts';

export const ROLE_FAMILIES = Object.keys(ROLE_FAMILY_LABELS) as RoleFamily[];

// Title/headline phrases per family (checked in this order on ties). Kept narrow: generic "engineer" never matches.
const FAMILY_PATTERNS: Record<RoleFamily, RegExp> = {
  inference: /\b(inference|model serving|serving infra\w*|vllm|triton|tensorrt|llm serving)\b/i,
  gpu_llm_infra: /\b(gpu|cuda|llm infra\w*|ai infra\w*|training infra\w*|nccl|hpc|distributed training|accelerator)\b/i,
  mlops: /\b(ml ?ops|mlops|machine learning operations|model ops|ml deployment)\b/i,
  ml_platform: /\b(ml platform|machine learning platform|ml infra\w*|machine learning infra\w*|ai platform|feature stores?|ml systems)\b/i,
  backend_payments: /\b(payments?|billing|fintech|ledger|backend|back-end)\b/i,
};
// Skills that count as evidence of a family (a fit reason cites the candidate's consented skills field).
const FAMILY_SKILLS: Record<RoleFamily, RegExp> = {
  inference: /\b(inference|model serving|vllm|triton|tensorrt|onnx|kserve|ray serve|quantization)\b/i,
  gpu_llm_infra: /\b(cuda|gpu|nccl|slurm|deepspeed|megatron|distributed training|triton)\b/i,
  mlops: /\b(mlflow|kubeflow|airflow|sagemaker|vertex|ci\/cd|mlops|model monitoring|dvc)\b/i,
  ml_platform: /\b(kubernetes|ray|kubeflow|feature stores?|mlflow|spark|terraform|pytorch|model serving|ml platform)\b/i,
  backend_payments: /\b(payments?|stripe|postgres\w*|java|go|golang|kafka|microservices|billing)\b/i,
};
const ADJACENT: Array<[RoleFamily, RoleFamily]> = [
  ['ml_platform', 'mlops'], ['ml_platform', 'gpu_llm_infra'], ['inference', 'gpu_llm_infra'], ['inference', 'ml_platform'],
];
const adjacent = (a: RoleFamily, b: RoleFamily) => ADJACENT.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

export function roleFamilyOf(text: string | null | undefined): RoleFamily | null {
  if (!text) return null;
  return (['inference', 'gpu_llm_infra', 'mlops', 'ml_platform', 'backend_payments'] as RoleFamily[])
    .find(family => FAMILY_PATTERNS[family].test(text)) ?? null;
}

// Rules fallback for parse_profile: current title outweighs headline, which outweighs skills.
export function classifyProfile(title: string | null, headline: string | null, skills: string[]): RoleFamily | null {
  const scores = new Map<RoleFamily, number>();
  const bump = (family: RoleFamily | null, by: number) => { if (family) scores.set(family, (scores.get(family) ?? 0) + by); };
  bump(roleFamilyOf(title), 3);
  bump(roleFamilyOf(headline), 2);
  for (const family of ROLE_FAMILIES) bump(family, skills.filter(skill => FAMILY_SKILLS[family].test(skill)).length * 0.5);
  const best = [...scores].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 1 ? best[0] : null;
}

export const familyLabel = (family: RoleFamily) => ROLE_FAMILY_LABELS[family];

type Profile = Pick<Candidate, 'displayName' | 'headline' | 'roleFamily' | 'skills' | 'history' | 'consent' | 'provenance'>;

export function fitFor(candidate: Profile, opening: Opening, evidence: Map<string, Evidence>): { fit: FitReason[]; score: number } | null {
  const fit: FitReason[] = [];
  let score = 0;
  const family = candidate.roleFamily;
  const label = familyLabel(opening.roleFamily);
  const edited = (field: 'roleFamily' | 'skills') => candidate.provenance?.[field] === 'Edited by candidate' ? ' (edited by candidate)' : '';
  if (family === opening.roleFamily) {
    score += 0.6;
    fit.push({ text: `Profile role family${edited('roleFamily')} is ${label}, the same family as this opening`, status: 'verified', profileField: 'roleFamily' });
  } else if (family && adjacent(family, opening.roleFamily)) {
    score += 0.3;
    fit.push({ text: `Profile role family${edited('roleFamily')} ${familyLabel(family)} is adjacent to ${label}`, status: 'verified', profileField: 'roleFamily' });
  }
  const skills = candidate.consent.shareSkills
    ? candidate.skills.filter(skill => FAMILY_SKILLS[opening.roleFamily].test(skill)).slice(0, 4) : [];
  if (skills.length) {
    score += Math.min(0.2, skills.length * 0.06);
    fit.push({ text: `Profile skills${edited('skills')} relevant to ${label}: ${skills.join(', ')}`, status: 'verified', profileField: 'skills' });
  }
  const past = candidate.consent.shareHistory ? candidate.history.find(item => roleFamilyOf(item.title) === opening.roleFamily) : undefined;
  if (past) {
    score += 0.15;
    fit.push({ text: `Profile history: ${past.title} at ${past.company}${past.from ? ' since ' + past.from.slice(0, 7) : ''}`,
      status: 'verified', profileField: 'history' });
  }
  if (score === 0) return null;
  for (const reason of opening.reasons) {
    const row = reason.evidenceId ? evidence.get(reason.evidenceId) : undefined;
    const dated = reason.date ? ` (${reason.date})` : '';
    fit.push(row?.verifiable && reason.evidenceId
      ? { text: `${opening.companyName}: ${reason.label}${dated}`, status: 'verified', evidenceId: reason.evidenceId }
      : { text: `${opening.companyName}: ${reason.label}${dated}`, status: 'cant_verify', ...(reason.evidenceId && { evidenceId: reason.evidenceId }) });
  }
  if (!candidate.consent.shareHistory) {
    fit.push({ text: `Years of ${label} experience: work history was not shared`, status: 'cant_verify' });
  }
  fit.push({ text: 'Seniority, location and work authorisation fit: not in the consented profile', status: 'cant_verify' });
  const matchScore = Math.round(Math.min(1, score * 0.75 + (opening.confidence ?? 0) * 0.25) * 100) / 100;
  return { fit, score: matchScore };
}

const candidateFacing = (opening: Opening) => opening.status === 'open' || opening.status === 'watch';

export function openingsForCandidate(candidate: Profile, openings: Opening[], evidence: Evidence[]): OpeningForCandidate[] {
  const rows = new Map(evidence.map(row => [row.id, row]));
  return openings.filter(candidateFacing).flatMap(opening => {
    const result = fitFor(candidate, opening, rows);
    return result ? [{ ...opening, fit: result.fit, matchScore: result.score }] : [];
  }).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.matchScore - a.matchScore);
}

export function matchesFor(candidate: Profile & { id: string }, openings: Opening[], evidence: Evidence[]): Match[] {
  return openingsForCandidate(candidate, openings, evidence).map(opening => ({
    candidateId: candidate.id, candidateLabel: candidate.displayName, openingId: opening.id, score: opening.matchScore, fit: opening.fit,
  }));
}
