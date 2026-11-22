import { ConvexError, v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { getProfile, requireIdentity, requireProfile } from "./access";
import { demoIdentity, demoIssuer, demoPerson, evidenceFields, profileStatus, profileView } from "../shared/contract";
import { evidenceForProfile, listOwnerMaterials, toEvidenceView, toMaterialView } from "./matching";

const profileResult = v.object({ id: v.id("profiles"), status: profileStatus });

function readiness(count: number): typeof profileStatus.type {
  return count > 0 ? "ready" : "awaiting_evidence";
}

export function normalizeLinkedIn(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ConvexError("Enter a valid LinkedIn profile URL.");
  }
  if (url.protocol !== "https:" || !/^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/.test(url.hostname)
    || !/^\/in\/[a-zA-Z0-9_%.-]+\/?$/.test(url.pathname) || url.username || url.password || url.port) {
    throw new ConvexError("Enter a valid LinkedIn profile URL.");
  }
  return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`;
}

export const saveProfile = mutation({
  args: {
    name: v.string(),
    linkedInUrl: v.string(),
    workSummary: v.optional(v.string()),
    discoverable: v.optional(v.boolean()),
  },
  returns: profileResult,
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const owner = identity.tokenIdentifier;
    const name = args.name.trim();
    if (!name || name.length > 100) throw new ConvexError("Enter a name of up to 100 characters.");
    const linkedInUrl = normalizeLinkedIn(args.linkedInUrl);
    const previous = await getProfile(ctx, owner);
    const previousEvidence = previous ? await evidenceForProfile(ctx, previous) : [];
    const evidenceIds = previousEvidence
      .filter((row) => previous?.linkedInUrl === linkedInUrl || row.mode === "candidate")
      .filter((row) => args.workSummary === undefined || row.mode !== "candidate")
      .map((row) => row._id);
    if (args.workSummary !== undefined) {
      const summary = args.workSummary.trim();
      if (summary.length > 2_000) throw new ConvexError("Keep the work summary under 2000 characters.");
      if (summary) {
        const id = await ctx.db.insert("evidence", {
          key: `candidate:${owner}:${Date.now()}`,
          owner,
          title: "Work summary",
          excerpt: summary,
          url: null,
          eventDate: null,
          retrievedAt: new Date().toISOString(),
          source: "Candidate submission",
          mode: "candidate",
        });
        evidenceIds.push(id);
      }
    }
    if (identity.issuer === demoIssuer && identity.subject === demoIdentity.candidate && linkedInUrl === demoPerson.linkedInUrl) {
      const sample = await ctx.db.query("evidence").withIndex("by_key", (q) => q.eq("key", "fixture:rahul:work")).unique();
      if (sample?.owner === owner && !evidenceIds.includes(sample._id)) evidenceIds.push(sample._id);
    }
    const data = { owner, name, linkedInUrl, discoverable: args.discoverable ?? previous?.discoverable ?? false, evidenceIds, updatedAt: Date.now() };
    if (previous) await ctx.db.patch(previous._id, data);
    const id = previous?._id ?? await ctx.db.insert("profiles", data);
    return { id, status: readiness(evidenceIds.length) };
  },
});

export const profile = query({
  args: {},
  returns: v.union(profileView, v.null()),
  handler: async (ctx) => {
    const { tokenIdentifier } = await requireIdentity(ctx);
    const candidate = await getProfile(ctx, tokenIdentifier);
    if (!candidate) return null;
    const evidence = await evidenceForProfile(ctx, candidate);
    const materials = await listOwnerMaterials(ctx, tokenIdentifier);
    return {
      id: candidate._id,
      name: candidate.name,
      linkedInUrl: candidate.linkedInUrl,
      discoverable: candidate.discoverable,
      status: readiness(evidence.length),
      evidence: evidence.map(toEvidenceView),
      materials: materials.map(toMaterialView),
    };
  },
});

export const profileForEnrichment = internalQuery({
  args: { owner: v.string() },
  returns: v.object({ linkedInUrl: v.string() }),
  handler: async (ctx, { owner }) => {
    const candidate = await requireProfile(ctx, owner);
    return { linkedInUrl: candidate.linkedInUrl };
  },
});

export const saveEnrichment = internalMutation({
  args: { owner: v.string(), linkedInUrl: v.string(), evidence: v.array(v.object(evidenceFields)) },
  returns: profileResult,
  handler: async (ctx, { owner, linkedInUrl, evidence }) => {
    const candidate = await requireProfile(ctx, owner);
    if (candidate.linkedInUrl !== linkedInUrl) throw new ConvexError("The profile URL changed. Refresh it again.");
    const existing = await evidenceForProfile(ctx, candidate);
    const evidenceIds = existing.filter((row) => row.mode !== "live").map((row) => row._id);
    for (const [index, row] of evidence.slice(0, 8).entries()) {
      const current = existing.find((item) => item.mode === "live" && item.excerpt === row.excerpt
        && item.title === row.title && item.eventDate === row.eventDate && item.url === row.url);
      if (current) {
        evidenceIds.push(current._id);
      } else {
        evidenceIds.push(await ctx.db.insert("evidence", { ...row, owner, key: `profile:${owner}:${Date.now()}:${index}` }));
      }
    }
    await ctx.db.patch(candidate._id, { evidenceIds, updatedAt: Date.now() });
    return { id: candidate._id, status: readiness(evidenceIds.length) };
  },
});
