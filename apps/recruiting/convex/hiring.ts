import type { comparisonRow, hiringCapability } from "../shared/contract";
import type { Id } from "./_generated/dataModel";

type Capability = typeof hiringCapability.type;
type ClassifiedCapability = Exclude<Capability, "unclassified">;

const capabilityRules = [
  { id: "inference_serving", label: "Inference serving", pattern: /\bvllm\b|\b(?:sglang|tensorrt-llm)\b|\binference (?:serving|platform|runtime)\b|\bmodel serving\b|\bserv(?:e|ing) (?:llms|models)\b/i },
  { id: "gpu_kernels", label: "GPU kernels", pattern: /\b(?:gpu|cuda|triton|attention) kernels?\b|\bkernel engineer\b/i },
  { id: "training_infrastructure", label: "Training infrastructure", pattern: /\btraining (?:infra(?:structure)?|platform|systems?)\b|\bdistributed (?:model )?training\b/i },
  { id: "evaluation_and_safety", label: "Evals and safety", pattern: /\bevals?\b|\b(?:llm|model) evaluations?\b|\b(?:ai|model) safety\b/i },
] satisfies { id: ClassifiedCapability; label: string; pattern: RegExp }[];

export function postingCapability(title: string, excerpt: string): Capability {
  const titleMatches = capabilityRules.filter(({ pattern }) => pattern.test(title));
  const matches = titleMatches.length ? titleMatches : capabilityRules.filter(({ pattern }) => pattern.test(excerpt));
  return matches.length === 1 ? matches[0].id : "unclassified";
}

type CompanyPostings = {
  row: Pick<typeof comparisonRow.type, "companyId" | "name">;
  jobCoverage: typeof comparisonRow.type.coverage;
  postings: { capability: Capability; evidenceId: Id<"evidence"> }[];
};

export function compareHiring([current, ...peers]: [CompanyPostings, ...CompanyPostings[]]) {
  const capabilities = [...capabilityRules, { id: "unclassified", label: "Unclassified" } as const].map(({ id, label }) => ({
    id,
    label,
    cells: [current, ...peers].map(({ row, jobCoverage, postings }) => {
      const evidenceIds = postings.filter(({ capability }) => capability === id).map(({ evidenceId }) => evidenceId);
      return { companyId: row.companyId, observedPostings: evidenceIds.length, coverage: jobCoverage, evidenceIds };
    }),
  }));

  const comparablePeers = peers.filter(({ jobCoverage, postings }) =>
    jobCoverage === "complete" && postings.length > 0 && postings.every(({ capability }) => capability !== "unclassified"));
  const differences = comparablePeers.flatMap((peer) => capabilities.flatMap(({ id, label, cells: [own] }) => {
    if (id === "unclassified" || own.coverage !== "complete" || own.observedPostings === 0) return [];
    if (peer.postings.some(({ capability }) => capability === id)) return [];
    return [{
      capabilityId: id,
      peerId: peer.row.companyId,
      takeaway: `${current.row.name} had ${own.observedPostings} ${label.toLowerCase()} ${own.observedPostings === 1 ? "posting" : "postings"} in this window. ${peer.row.name}’s observed postings covered other work.`,
      caveat: "Public postings may reflect backfills or short-term projects.",
      evidenceIds: [...own.evidenceIds.slice(0, 3), ...peer.postings.slice(0, 3).map(({ evidenceId }) => evidenceId)],
      count: own.observedPostings,
    }];
  }));
  const best = differences.sort((left, right) => right.count - left.count)[0];
  if (!best) return { capabilities, difference: null };
  const { count: _count, ...difference } = best;
  return { capabilities, difference };
}
