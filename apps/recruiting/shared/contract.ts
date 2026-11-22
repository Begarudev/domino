import { v } from "convex/values";

export const sourceMode = v.union(v.literal("fixture"), v.literal("live"), v.literal("cached"));
export const evidenceMode = v.union(sourceMode, v.literal("candidate"));
export const materialKind = v.union(v.literal("resume"), v.literal("portfolio"), v.literal("work_sample"));
export const profileStatus = v.union(v.literal("awaiting_evidence"), v.literal("ready"));
export const signalKind = v.union(
  v.literal("job_post"),
  v.literal("hire"),
  v.literal("departure"),
  v.literal("headcount"),
  v.literal("funding"),
);

export const evidenceFields = {
  title: v.string(),
  excerpt: v.string(),
  url: v.union(v.string(), v.null()),
  eventDate: v.union(v.string(), v.null()),
  retrievedAt: v.string(),
  source: v.string(),
  mode: evidenceMode,
};
export const evidenceView = v.object({ id: v.id("evidence"), ...evidenceFields });
export const materialView = v.object({
  id: v.id("materials"),
  kind: materialKind,
  label: v.string(),
});
export const profileView = v.object({
  id: v.id("profiles"),
  name: v.string(),
  linkedInUrl: v.string(),
  discoverable: v.boolean(),
  status: profileStatus,
  evidence: v.array(evidenceView),
  materials: v.array(materialView),
});
export const recipientView = v.object({ name: v.string(), title: v.string() });
export const roleFields = {
  companyId: v.id("companies"),
  companyName: v.string(),
  roleId: v.id("roles"),
  roleTitle: v.string(),
};
export const introOptionView = v.object({
  recommendationId: v.id("roles"),
  ...roleFields,
  reason: v.string(),
  jobEvidence: evidenceView,
  profileEvidence: evidenceView,
  recipient: recipientView,
});
export const sharingFields = {
  includeLinkedIn: v.boolean(),
  materialIds: v.array(v.id("materials")),
};
export const introReceipt = v.object({
  id: v.id("intros"),
  companyId: v.id("companies"),
  roleId: v.id("roles"),
  status: v.literal("delivered"),
  deliveredAt: v.number(),
});
export const recruiterIntroView = v.object({
  ...roleFields,
  ...introReceipt.fields,
  candidateName: v.string(),
  candidateLinkedIn: v.union(v.string(), v.null()),
  message: v.string(),
  matchExcerpt: v.string(),
  jobEvidence: evidenceView,
  materials: v.array(materialView),
  opened: v.boolean(),
});
export const suggestionView = v.object({
  ...roleFields,
  candidateId: v.id("profiles"),
  candidateName: v.string(),
  reason: v.string(),
  matchExcerpt: v.string(),
  jobEvidence: evidenceView,
});
export const inboxView = v.object({
  companyId: v.id("companies"),
  companyName: v.string(),
  newIntroCount: v.number(),
  introductions: v.array(recruiterIntroView),
  suggestions: v.array(suggestionView),
});
export const comparisonRow = v.object({
  companyId: v.id("companies"),
  name: v.string(),
  domain: v.string(),
  jobPosts: v.number(),
  hiresObserved: v.number(),
  departuresObserved: v.number(),
  headcount: v.union(v.number(), v.null()),
  headcountChange: v.union(v.number(), v.null()),
  funding: v.union(v.object({ amountUsd: v.union(v.number(), v.null()), round: v.string(), date: v.string() }), v.null()),
  evidenceIds: v.array(v.id("evidence")),
  coverage: v.union(v.literal("complete"), v.literal("partial"), v.literal("unavailable")),
  incompleteKinds: v.array(signalKind),
  mode: sourceMode,
});
export const dashboardView = v.object({
  companyId: v.id("companies"),
  from: v.string(),
  through: v.string(),
  overview: comparisonRow,
  peers: v.array(comparisonRow),
  signals: v.array(v.object({
    kind: signalKind,
    date: v.string(),
    label: v.string(),
    evidenceId: v.id("evidence"),
  })),
});

export const demoPerson = {
  name: "Rahul",
  linkedInUrl: "https://www.linkedin.com/in/rahul-domino-demo",
};

export const demoIdentity = {
  candidate: "domino-rahul",
  recruiter: "domino-nova-recruiter",
  otherRecruiter: "domino-atlas-recruiter",
};

export const demoIssuer = "https://domino.test";
export const demoAudience = "domino-recruiting";
