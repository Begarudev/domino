import { v } from "convex/values";
import { demoCandidates, demoCompanies, demoRetrievedAt, demoWindow, rahulWork } from "../fixtures/demo";
import { demoIdentity, demoIssuer, demoPerson } from "../shared/contract";
import { identityKey } from "./access";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

export const seed = internalMutation({
  args: { reset: v.optional(v.boolean()) },
  returns: v.object({ novaCompanyId: v.id("companies"), atlasCompanyId: v.id("companies"), novaRoleId: v.id("roles") }),
  handler: async (ctx, { reset }) => {
    const candidateOwner = identityKey(demoIssuer, demoIdentity.candidate);
    if (reset) {
      const [profile, materials] = await Promise.all([
        ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("owner", candidateOwner)).unique(),
        ctx.db.query("materials").withIndex("by_owner", (q) => q.eq("owner", candidateOwner)).take(10),
      ]);
      if (profile) {
        const intros = await ctx.db.query("intros").withIndex("by_candidate_and_role", (q) => q.eq("candidateId", profile._id)).take(100);
        await Promise.all(intros.map((row) => ctx.db.delete(row._id)));
        const evidence = await Promise.all(profile.evidenceIds.map((id) => ctx.db.get(id)));
        await Promise.all(evidence.filter((row): row is Doc<"evidence"> =>
          row !== null && row.owner === candidateOwner && row.mode !== "fixture")
          .map((row) => ctx.db.delete(row._id)));
        await ctx.db.delete(profile._id);
      }
      for (const material of materials) {
        if (material.storageId) await ctx.storage.delete(material.storageId);
        await ctx.db.delete(material._id);
      }
    }

    async function putEvidence(row: Omit<Doc<"evidence">, "_id" | "_creationTime">) {
      const existing = await ctx.db.query("evidence").withIndex("by_key", (q) => q.eq("key", row.key)).unique();
      if (!existing) return ctx.db.insert("evidence", row);
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }

    const companyIds: Id<"companies">[] = [];
    const roleIds: Id<"roles">[] = [];
    for (const item of demoCompanies) {
      const existing = await ctx.db.query("companies").withIndex("by_domain", (q) => q.eq("domain", item.domain)).unique();
      const company = { name: item.name, domain: item.domain, mode: "fixture" as const, coverageFrom: demoWindow.from, coverageThrough: demoWindow.through };
      if (existing) await ctx.db.patch(existing._id, company);
      const companyId = existing?._id ?? await ctx.db.insert("companies", { ...company, peerIds: [] });
      companyIds.push(companyId);
      const owner = identityKey(demoIssuer, item.recruiter.subject);
      const recruiter = await ctx.db.query("recruiters")
        .withIndex("by_company_and_owner", (q) => q.eq("companyId", companyId).eq("owner", owner)).unique();
      const recruiterData = { owner, companyId, name: item.recruiter.name, title: item.recruiter.title, active: true };
      if (recruiter) await ctx.db.patch(recruiter._id, recruiterData);
      const recruiterId = recruiter?._id ?? await ctx.db.insert("recruiters", recruiterData);

      async function putSignal(signal: {
        kind: "job_post" | "hire" | "departure" | "funding" | "headcount";
        date: string;
        label: string;
        excerpt?: string;
        count?: number;
        round?: string;
        amountUsd?: number;
      }) {
        const key = `fixture:${item.domain}:${signal.kind}:${signal.date}:${signal.label}`;
        const evidenceId = await putEvidence({
          key,
          companyId,
          title: signal.label,
          excerpt: signal.excerpt ?? signal.label,
          url: `https://${item.domain}/demo-evidence/${signal.kind}/${signal.date}`,
          eventDate: signal.date,
          retrievedAt: demoRetrievedAt,
          source: "DOMINO demo fixture",
          mode: "fixture",
        });
        const existingSignal = await ctx.db.query("signals").withIndex("by_key", (q) => q.eq("key", key)).unique();
        const { excerpt: _excerpt, ...fields } = signal;
        const data = { ...fields, key, companyId, evidenceId };
        if (existingSignal) await ctx.db.patch(existingSignal._id, data);
        else await ctx.db.insert("signals", data);
        return evidenceId;
      }

      for (const job of item.roles) {
        const evidenceId = await putSignal({ kind: "job_post", date: job.date, label: job.title, excerpt: job.excerpt });
        const key = `fixture:${item.domain}:${job.title}`;
        const role = await ctx.db.query("roles").withIndex("by_key", (q) => q.eq("key", key)).unique();
        const data = { key, companyId, title: job.title, evidenceId, recruiterId, active: true };
        if (role) await ctx.db.patch(role._id, data);
        roleIds.push(role?._id ?? await ctx.db.insert("roles", data));
      }
      await putSignal({ kind: "headcount", date: demoWindow.from, label: `${item.name} baseline headcount`, count: item.headcount[0] });
      await putSignal({ kind: "headcount", date: demoWindow.through, label: `${item.name} current headcount`, count: item.headcount[1] });
      await putSignal({ kind: "funding", ...item.funding, label: `${item.name} ${item.funding.round} round` });
      for (const transition of item.transitions) await putSignal(transition);
    }
    for (const companyId of companyIds) {
      await ctx.db.patch(companyId, { peerIds: companyIds.filter((peer) => peer !== companyId) });
    }

    await putEvidence({
      key: "fixture:rahul:work", owner: candidateOwner, title: "Production inference project",
      excerpt: rahulWork, url: demoPerson.linkedInUrl, eventDate: null, retrievedAt: demoRetrievedAt,
      source: "Candidate demo profile", mode: "fixture",
    });
    for (const person of demoCandidates) {
      const owner = identityKey(demoIssuer, person.subject);
      const linkedInUrl = `https://www.linkedin.com/in/${person.subject}-demo`;
      const evidenceId = await putEvidence({
        key: `fixture:${person.subject}:work`, owner, title: "Professional work summary", excerpt: person.excerpt,
        url: linkedInUrl, eventDate: null, retrievedAt: demoRetrievedAt, source: "Candidate demo profile", mode: "fixture",
      });
      const profile = await ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("owner", owner)).unique();
      const data = { owner, name: person.name, linkedInUrl, discoverable: true, updatedAt: Date.now(), evidenceIds: [evidenceId] };
      if (profile) await ctx.db.patch(profile._id, data);
      else await ctx.db.insert("profiles", data);
    }
    return { novaCompanyId: companyIds[0], atlasCompanyId: companyIds[1], novaRoleId: roleIds[0] };
  },
});
