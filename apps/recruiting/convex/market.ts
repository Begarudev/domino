import { ConvexError, v } from "convex/values";
import { identityKey, requireCompanyMember } from "./access";
import { internalMutation, mutation } from "./_generated/server";
import { signalKind } from "../shared/contract";

const signal = v.object({
  key: v.string(), domain: v.string(), date: v.string(), kind: signalKind, label: v.string(),
  excerpt: v.string(), url: v.union(v.string(), v.null()), count: v.optional(v.number()),
  amountUsd: v.optional(v.number()), round: v.optional(v.string()),
});

export const applySnapshot = internalMutation({
  args: {
    companies: v.array(v.object({ domain: v.string(), name: v.string() })),
    signals: v.array(signal),
    incompleteKinds: v.array(signalKind),
    from: v.string(),
    through: v.string(),
    retrievedAt: v.string(),
  },
  returns: v.object({ companies: v.number(), signals: v.number() }),
  handler: async (ctx, args) => {
    const entries = await Promise.all(args.companies.map(async (record) => {
      const previous = await ctx.db.query("companies").withIndex("by_domain", (q) => q.eq("domain", record.domain)).unique();
      const fields = { ...record, mode: "live" as const, coverageFrom: args.from, coverageThrough: args.through, incompleteKinds: args.incompleteKinds };
      if (previous) await ctx.db.patch(previous._id, fields);
      return [record.domain, previous?._id ?? await ctx.db.insert("companies", { ...fields, peerIds: [] })] as const;
    }));
    const companyByDomain = new Map(entries);
    const peers = entries.map(([, id]) => id);
    for (const companyId of peers) await ctx.db.patch(companyId, { peerIds: peers.filter((peer) => peer !== companyId) });

    let written = 0;
    for (const source of new Map(args.signals.map((row) => [row.key, row])).values()) {
      const { domain, excerpt, url, ...row } = source;
      const companyId = companyByDomain.get(domain);
      if (!companyId) continue;
      const previous = await ctx.db.query("signals").withIndex("by_key", (q) => q.eq("key", row.key)).unique();
      const evidence = previous ? await ctx.db.get(previous.evidenceId) : null;
      const changed = !evidence || evidence.excerpt !== excerpt || evidence.url !== url
        || evidence.eventDate !== row.date || evidence.title !== row.label;
      const evidenceId = changed ? await ctx.db.insert("evidence", {
        key: `${row.key}:at:${args.retrievedAt}`,
        companyId,
        title: row.label,
        excerpt,
        url,
        eventDate: row.date,
        retrievedAt: args.retrievedAt,
        source: row.kind === "job_post" ? "Crustdata Job Search (date indexed)" : "Crustdata",
        mode: "live",
      }) : evidence._id;
      if (previous) await ctx.db.replace(previous._id, { ...row, companyId, evidenceId });
      else await ctx.db.insert("signals", { ...row, companyId, evidenceId });
      written++;
    }
    return { companies: entries.length, signals: written };
  },
});

export const registerRecruiter = internalMutation({
  args: { domain: v.string(), issuer: v.string(), subject: v.string(), name: v.string(), title: v.string() },
  returns: v.id("recruiters"),
  handler: async (ctx, args) => {
    const company = await ctx.db.query("companies").withIndex("by_domain", (q) => q.eq("domain", args.domain)).unique();
    if (!company) throw new ConvexError("Import the company before registering a recruiter.");
    const owner = identityKey(args.issuer, args.subject);
    const member = await ctx.db.query("recruiters")
      .withIndex("by_company_and_owner", (q) => q.eq("companyId", company._id).eq("owner", owner)).unique();
    const fields = { owner, companyId: company._id, name: args.name, title: args.title, active: true };
    if (member) {
      await ctx.db.patch(member._id, fields);
      return member._id;
    }
    return ctx.db.insert("recruiters", fields);
  },
});

export const publishRole = mutation({
  args: { companyId: v.id("companies"), evidenceId: v.id("evidence") },
  returns: v.id("roles"),
  handler: async (ctx, { companyId, evidenceId }) => {
    const recruiter = await requireCompanyMember(ctx, companyId);
    const evidence = await ctx.db.get(evidenceId);
    if (evidence?.companyId !== companyId || evidence.source !== "Crustdata Job Search (date indexed)") {
      throw new ConvexError("Select a job posting for your company.");
    }
    const key = `published:${evidence.key.split(":at:")[0]}`;
    const previous = await ctx.db.query("roles").withIndex("by_key", (q) => q.eq("key", key)).unique();
    const role = { key, companyId, title: evidence.title, evidenceId, recruiterId: recruiter._id, active: true };
    if (!previous) return ctx.db.insert("roles", role);
    await ctx.db.patch(previous._id, role);
    return previous._id;
  },
});
