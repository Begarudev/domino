"use node";

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { requireIdentity } from "./access";
import { profileStatus, type signalKind } from "../shared/contract";
import { domainOf, enrichCompanies, enrichLinkedIn, searchCompanyJobs, searchTalentMoves } from "./provider/crustdata";
import type { Id } from "./_generated/dataModel";

export const enrichProfile = action({
  args: { consent: v.literal(true) },
  returns: v.object({ id: v.id("profiles"), status: profileStatus }),
  handler: async (ctx): Promise<{ id: Id<"profiles">; status: typeof profileStatus.type }> => {
    const { tokenIdentifier: owner } = await requireIdentity(ctx);
    const { linkedInUrl }: { linkedInUrl: string } = await ctx.runQuery(internal.profiles.profileForEnrichment, { owner });
    const evidence = await enrichLinkedIn(linkedInUrl, new Date().toISOString());
    return await ctx.runMutation(internal.profiles.saveEnrichment, { owner, linkedInUrl, evidence });
  },
});

export const refreshMarket = internalAction({
  args: { domains: v.array(v.string()), from: v.string(), through: v.string() },
  returns: v.object({ companies: v.number(), signals: v.number(), partial: v.boolean() }),
  handler: async (ctx, { domains, from, through }): Promise<{ companies: number; signals: number; partial: boolean }> => {
    const canonical = [...new Set(domains.map(domainOf))].filter((domain): domain is string =>
      domain !== null && !domain.endsWith(".example"));
    if (canonical.length < 1 || canonical.length > 6) throw new ConvexError("Provide one to six real company domains.");
    const start = Date.parse(from);
    const end = Date.parse(through);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 30 * 86_400_000
      || new Date(start).toISOString().slice(0, 10) !== from || new Date(end).toISOString().slice(0, 10) !== through) {
      throw new ConvexError("Use a YYYY-MM-DD market window of up to 31 days.");
    }
    const [companies, jobs, moves] = await Promise.all([
      enrichCompanies(canonical, from, through),
      searchCompanyJobs(canonical, from, through).catch(() => null),
      searchTalentMoves(canonical, from, through).catch(() => null),
    ]);
    if (!companies.length) throw new ConvexError("Crustdata did not resolve any company in this set.");
    const incompleteKinds: Array<typeof signalKind.type> = [];
    if (!jobs || jobs.partial) incompleteKinds.push("job_post");
    if (!moves || moves.partial) incompleteKinds.push("hire", "departure");
    if (companies.some((company) => !company.signals.some((signal) => signal.kind === "headcount"))) incompleteKinds.push("headcount");
    const result: { companies: number; signals: number } = await ctx.runMutation(internal.market.applySnapshot, {
      companies: companies.map(({ domain, name }) => ({ domain, name })),
      signals: [...companies.flatMap((company) => company.signals), ...(jobs?.signals ?? []), ...(moves?.signals ?? [])],
      incompleteKinds, from, through, retrievedAt: new Date().toISOString(),
    });
    return { ...result, partial: incompleteKinds.length > 0 || result.companies < canonical.length };
  },
});
