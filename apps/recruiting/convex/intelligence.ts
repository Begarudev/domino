"use node";

import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { api } from "./_generated/api";
import { action } from "./_generated/server";
import { dashboardView, evidenceView } from "../shared/contract";
import { classifyWithDecisions, classifyWithFlash, generateJson } from "./provider/models";

const family = v.union(v.literal("inference_serving"), v.literal("gpu_kernels"), v.literal("ml_infrastructure"), v.literal("needs_review"));
const classification = v.object({ family, confidence: v.union(v.number(), v.null()) });
const summaryView = v.object({ takeaway: v.string(), evidenceIds: v.array(v.id("evidence")) });

export const classifyPosting = action({
  args: { companyId: v.id("companies"), evidenceId: v.id("evidence"), provider: v.union(v.literal("flash"), v.literal("decisions")) },
  returns: classification,
  handler: async (ctx, { companyId, evidenceId, provider }): Promise<typeof classification.type> => {
    const evidence: typeof evidenceView.type | null = await ctx.runQuery(api.companies.getEvidence, { companyId, evidenceId });
    if (!evidence || evidence.source !== "Crustdata Job Search (date indexed)") {
      throw new ConvexError("Select a sourced job posting to classify.");
    }
    const job = `${evidence.title}\n${evidence.excerpt}`.slice(0, 2_300);
    return provider === "decisions" ? classifyWithDecisions(job) : classifyWithFlash(job);
  },
});

export const summarizeComparison = action({
  args: { companyId: v.id("companies"), from: v.optional(v.string()), through: v.optional(v.string()) },
  returns: summaryView,
  handler: async (ctx, args): Promise<typeof summaryView.type> => {
    const dashboard: typeof dashboardView.type = await ctx.runQuery(api.companies.companyDashboard, args);
    const signals = dashboard.signals.filter((signal) => signal.kind !== "headcount").slice(0, 12);
    if (!signals.length) throw new ConvexError("The comparison has no dated activity to summarize.");
    const peers = dashboard.peers.map(({ name, jobPosts, hiresObserved, departuresObserved, headcountChange, coverage }) => ({
      name, jobPosts, hiresObserved, departuresObserved, headcountChange, coverage,
    }));
    const summary = await generateJson(
      process.env.VERTEX_NEON_MODEL || "gemini-4-neon",
      `Write one short, conditional company intelligence observation from this data. Return JSON {"takeaway":"...","sourceIndexes":[0]}. Use only index numbers of the supplied dated activity. Describe observations without assuming strategic intent or treating partial coverage as zero activity.\n${JSON.stringify({
        company: dashboard.overview.name, from: dashboard.from, through: dashboard.through,
        coverage: dashboard.overview.coverage, peers,
        activity: signals.map(({ kind, date, label }, index) => ({ index, kind, date, label })),
      })}`,
      z.object({ takeaway: z.string().min(1).max(420), sourceIndexes: z.array(z.number().int().min(0).max(signals.length - 1)).min(1).max(5) }),
    );
    return { takeaway: summary.takeaway, evidenceIds: [...new Set(summary.sourceIndexes.map((index) => signals[index].evidenceId))] };
  },
});
