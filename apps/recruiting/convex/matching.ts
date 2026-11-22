import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const skills = [
  { label: "inference serving", terms: /\bvllm\b|\b(sglang|tensorrt-llm)\b|inference (serving|platform|runtime)|model serving|serv(e|ing) (llms|models)/i },
  { label: "Kubernetes", terms: /\b(kubernetes|k8s)\b/i },
  { label: "GPU kernels", terms: /\b(cuda|triton|cutlass)\b|gpu kernels?/i },
  { label: "latency optimization", terms: /\blatency\b|\bthroughput\b|performance optimization/i },
  { label: "ML infrastructure", terms: /\bmlops\b|ml (infra|platform)|machine learning infrastructure/i },
  { label: "evaluation", terms: /\bevals?\b|llm evaluation|model evaluation/i },
  { label: "Python", terms: /\bpython\b/i },
];

export function toEvidenceView(row: Doc<"evidence">) {
  return {
    id: row._id,
    title: row.title,
    excerpt: row.excerpt,
    url: row.url,
    eventDate: row.eventDate,
    retrievedAt: row.retrievedAt,
    source: row.source,
    mode: row.mode,
  };
}

export function toMaterialView(row: Doc<"materials">) {
  return { id: row._id, kind: row.kind, label: row.label };
}

export async function evidenceForProfile(ctx: QueryCtx, profile: Doc<"profiles">) {
  const rows = await Promise.all(profile.evidenceIds.map((id) => ctx.db.get(id)));
  return rows.filter((row): row is Doc<"evidence"> => row !== null && row.owner === profile.owner);
}

export async function resolveRole(ctx: QueryCtx, role: Doc<"roles">) {
  if (!role.active || !role.recruiterId) return null;
  const [company, recruiter, jobEvidence] = await Promise.all([
    ctx.db.get(role.companyId),
    ctx.db.get(role.recruiterId),
    ctx.db.get(role.evidenceId),
  ]);
  if (!company || !recruiter?.active || recruiter.companyId !== company._id || !jobEvidence || jobEvidence.owner) {
    return null;
  }
  return { role, company, recruiter, jobEvidence };
}

export type ResolvedRole = NonNullable<Awaited<ReturnType<typeof resolveRole>>>;

export function matchRole(role: ResolvedRole, candidateEvidence: Doc<"evidence">[]) {
  const needed = skills.filter(({ terms }) => terms.test(`${role.role.title}\n${role.jobEvidence.excerpt}`));
  const matches = candidateEvidence.flatMap((evidence) => {
    const matched = needed.filter(({ terms }) => terms.test(evidence.excerpt));
    const specific = matched.some(({ label }) => ["inference serving", "GPU kernels", "ML infrastructure", "evaluation"].includes(label));
    return specific || matched.length > 1 ? [{ evidence, matched }] : [];
  }).sort((left, right) => right.matched.length - left.matched.length);
  const best = matches[0];
  if (!best) return null;
  return {
    score: best.matched.length,
    profileEvidence: best.evidence,
    reason: `The role and this work both cover ${best.matched.map(({ label }) => label).join(", ")}.`,
  };
}

export function roleFields(role: ResolvedRole) {
  return {
    companyId: role.company._id,
    companyName: role.company.name,
    roleId: role.role._id,
    roleTitle: role.role.title,
  };
}

export async function listOwnerMaterials(ctx: QueryCtx, owner: string) {
  return ctx.db.query("materials").withIndex("by_owner", (q) => q.eq("owner", owner)).take(10);
}

export async function searchIntro(ctx: QueryCtx, candidateId: Id<"profiles">, roleId: Id<"roles">) {
  return ctx.db.query("intros")
    .withIndex("by_candidate_and_role", (q) => q.eq("candidateId", candidateId).eq("roleId", roleId))
    .unique();
}
