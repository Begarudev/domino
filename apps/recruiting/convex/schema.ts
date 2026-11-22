import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { evidenceFields, materialKind, signalKind, sourceMode } from "../shared/contract";

export default defineSchema({
  profiles: defineTable({
    owner: v.string(),
    name: v.string(),
    linkedInUrl: v.string(),
    discoverable: v.boolean(),
    evidenceIds: v.array(v.id("evidence")),
    updatedAt: v.number(),
  })
    .index("by_owner", ["owner"])
    .index("by_discoverable_and_updated_at", ["discoverable", "updatedAt"]),
  materials: defineTable({
    owner: v.string(),
    kind: materialKind,
    label: v.string(),
    url: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  }).index("by_owner", ["owner"]),
  evidence: defineTable({
    ...evidenceFields,
    key: v.string(),
    owner: v.optional(v.string()),
    companyId: v.optional(v.id("companies")),
  }).index("by_key", ["key"]),
  companies: defineTable({
    name: v.string(),
    domain: v.string(),
    mode: sourceMode,
    peerIds: v.array(v.id("companies")),
    coverageFrom: v.optional(v.string()),
    coverageThrough: v.optional(v.string()),
    incompleteKinds: v.optional(v.array(signalKind)),
  }).index("by_domain", ["domain"]),
  recruiters: defineTable({
    owner: v.string(),
    companyId: v.id("companies"),
    name: v.string(),
    title: v.string(),
    active: v.boolean(),
  })
    .index("by_owner", ["owner"])
    .index("by_company_and_owner", ["companyId", "owner"]),
  roles: defineTable({
    key: v.string(),
    companyId: v.id("companies"),
    title: v.string(),
    active: v.boolean(),
    recruiterId: v.optional(v.id("recruiters")),
    evidenceId: v.id("evidence"),
  })
    .index("by_key", ["key"])
    .index("by_active", ["active"])
    .index("by_company_and_active", ["companyId", "active"]),
  signals: defineTable({
    key: v.string(),
    companyId: v.id("companies"),
    kind: signalKind,
    date: v.string(),
    label: v.string(),
    count: v.optional(v.number()),
    round: v.optional(v.string()),
    amountUsd: v.optional(v.number()),
    evidenceId: v.id("evidence"),
  })
    .index("by_key", ["key"])
    .index("by_company_and_date", ["companyId", "date"])
    .index("by_company_and_kind_and_date", ["companyId", "kind", "date"]),
  intros: defineTable({
    candidateId: v.id("profiles"),
    owner: v.string(),
    companyId: v.id("companies"),
    roleId: v.id("roles"),
    requestKey: v.string(),
    candidateName: v.string(),
    candidateLinkedIn: v.union(v.string(), v.null()),
    message: v.string(),
    matchExcerpt: v.string(),
    jobEvidenceId: v.id("evidence"),
    materialIds: v.array(v.id("materials")),
    deliveredAt: v.number(),
    openedAt: v.optional(v.number()),
  })
    .index("by_candidate_and_role", ["candidateId", "roleId"])
    .index("by_candidate_and_request_key", ["candidateId", "requestKey"])
    .index("by_company_and_delivered_at", ["companyId", "deliveredAt"]),
});
