import { ConvexError, v } from "convex/values";
import { dashboardView, evidenceView } from "../shared/contract";
import { requireCompanyMember } from "./access";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { compareHiring, postingCapability } from "./hiring";
import { toEvidenceView } from "./matching";

const dayMs = 86_400_000;
const signalLimit = 200;

function isoDay(input: string) {
  const ms = Date.parse(input);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== input) {
    throw new ConvexError("Use YYYY-MM-DD for the comparison dates.");
  }
  return ms;
}

async function comparison(ctx: QueryCtx, company: Doc<"companies">, from: string, through: string) {
  const [signals, firstHeadcount, headcount, funding] = await Promise.all([
    ctx.db.query("signals").withIndex("by_company_and_date", (q) => q.eq("companyId", company._id).gte("date", from).lte("date", through)).take(signalLimit + 1),
    ctx.db.query("signals").withIndex("by_company_and_kind_and_date", (q) => q.eq("companyId", company._id).eq("kind", "headcount").lte("date", from)).order("desc").first(),
    ctx.db.query("signals").withIndex("by_company_and_kind_and_date", (q) => q.eq("companyId", company._id).eq("kind", "headcount").lte("date", through)).order("desc").first(),
    ctx.db.query("signals").withIndex("by_company_and_kind_and_date", (q) => q.eq("companyId", company._id).eq("kind", "funding").lte("date", through)).order("desc").first(),
  ]);
  const shown = signals.slice(0, signalLimit);
  const jobSignals = shown.filter(({ kind }) => kind === "job_post").reverse();
  const jobs = await Promise.all(jobSignals.map(async ({ evidenceId, date }) => {
    const evidence = await ctx.db.get(evidenceId);
    if (!evidence || evidence.owner || evidence.companyId !== company._id || evidence.eventDate !== date) return null;
    return { capability: postingCapability(evidence.title, evidence.excerpt), evidenceId };
  }));
  const postings = jobs.filter((job) => job !== null);
  const evidenceIds = [...new Set([
    ...shown.map((signal) => signal.evidenceId),
    ...[firstHeadcount, headcount, funding].flatMap((signal) => signal ? [signal.evidenceId] : []),
  ])];
  const windowCoverage = !company.coverageFrom || !company.coverageThrough ? "unavailable"
    : company.coverageFrom > from || company.coverageThrough < through || signals.length > signalLimit ? "partial" : "complete";
  const coverage = windowCoverage === "complete" && company.incompleteKinds?.length ? "partial" : windowCoverage;
  const jobCoverage = windowCoverage === "complete" && (company.incompleteKinds?.includes("job_post") || postings.length !== jobSignals.length)
    ? "partial" : windowCoverage;
  const headcountChange = firstHeadcount?.count && headcount?.count !== undefined && headcount.date > firstHeadcount.date
    ? Math.round(((headcount.count - firstHeadcount.count) / firstHeadcount.count) * 1_000) / 10
    : null;
  return {
    row: {
      companyId: company._id,
      name: company.name,
      domain: company.domain,
      jobPosts: jobSignals.length,
      hiresObserved: shown.filter((signal) => signal.kind === "hire").reduce((count, signal) => count + (signal.count ?? 1), 0),
      departuresObserved: shown.filter((signal) => signal.kind === "departure").reduce((count, signal) => count + (signal.count ?? 1), 0),
      headcount: headcount?.count ?? null,
      headcountChange,
      funding: funding ? { amountUsd: funding.amountUsd ?? null, round: funding.round ?? "Undisclosed", date: funding.date } : null,
      evidenceIds,
      coverage,
      incompleteKinds: company.incompleteKinds ?? [],
      mode: company.mode,
    },
    signals: shown,
    postings,
    jobCoverage,
  } as const;
}

export const companyDashboard = query({
  args: { companyId: v.id("companies"), from: v.optional(v.string()), through: v.optional(v.string()) },
  returns: dashboardView,
  handler: async (ctx, args) => {
    await requireCompanyMember(ctx, args.companyId);
    const company = await ctx.db.get(args.companyId);
    if (!company) throw new ConvexError("Company is unavailable.");
    const through = args.through ?? company.coverageThrough ?? new Date().toISOString().slice(0, 10);
    const throughMs = isoDay(through);
    const from = args.from ?? new Date(throughMs - 29 * dayMs).toISOString().slice(0, 10);
    const fromMs = isoDay(from);
    if (fromMs > throughMs || throughMs - fromMs > 365 * dayMs) throw new ConvexError("Choose a comparison window of up to one year.");
    const peers = (await Promise.all(company.peerIds.slice(0, 5).map((id) => ctx.db.get(id))))
      .filter((peer) => peer !== null);
    const [current, peerResults] = await Promise.all([
      comparison(ctx, company, from, through),
      Promise.all(peers.map((peer) => comparison(ctx, peer, from, through))),
    ]);
    return {
      companyId: company._id,
      from,
      through,
      overview: current.row,
      peers: peerResults.map((result) => result.row),
      hiring: compareHiring([current, ...peerResults]),
      signals: current.signals.slice().reverse().map((signal) => ({
        kind: signal.kind, date: signal.date, label: signal.label, evidenceId: signal.evidenceId,
      })),
    };
  },
});

export const getEvidence = query({
  args: { companyId: v.id("companies"), evidenceId: v.id("evidence") },
  returns: v.union(evidenceView, v.null()),
  handler: async (ctx, { companyId, evidenceId }) => {
    await requireCompanyMember(ctx, companyId);
    const [company, item] = await Promise.all([ctx.db.get(companyId), ctx.db.get(evidenceId)]);
    if (!company || !item?.companyId || item.owner) return null;
    if (item.companyId !== companyId && !company.peerIds.includes(item.companyId)) return null;
    return toEvidenceView(item);
  },
});
