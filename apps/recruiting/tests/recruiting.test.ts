/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { demoIdentity, demoIssuer, demoPerson } from "../shared/contract";

const modules = import.meta.glob("../convex/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.mutation(internal.demo.seed, {});
  const as = (subject: string) => t.withIdentity({ issuer: demoIssuer, subject, tokenIdentifier: `${demoIssuer}|${subject}` });
  const candidate = as(demoIdentity.candidate);
  await candidate.mutation(api.profiles.saveProfile, demoPerson);
  return { t, ids, candidate, recruiter: as(demoIdentity.recruiter), other: as(demoIdentity.otherRecruiter) };
}

describe("recruiting demo", () => {
  it("routes one opted-in intro to the recruiter and opens dated market evidence", async () => {
    const { candidate, recruiter, other, ids } = await setup();
    const options = await candidate.query(api.introductions.listIntroOptions);
    expect(options.map((item) => item.companyName)).toEqual(["Nova Labs", "Atlas AI", "Meridian Compute"]);
    const attachment = await candidate.mutation(api.materials.addLink, {
      kind: "portfolio", label: "Work example", url: "https://portfolio.example/work",
    });
    const preview = await candidate.query(api.introductions.previewIntro, { recommendationId: options[0].recommendationId });
    const args = {
      recommendationId: options[0].recommendationId,
      confirmationToken: preview.confirmationToken,
      requestKey: "rahul-inference-test",
      sharing: { includeLinkedIn: false, materialIds: [attachment.id] },
    };
    const first = await candidate.mutation(api.introductions.confirmIntro, args);
    expect(await candidate.mutation(api.introductions.confirmIntro, { ...args, requestKey: "rahul-retry-test" })).toEqual(first);
    const company = { companyId: ids.novaCompanyId };
    const inbox = await recruiter.query(api.introductions.recruiterInbox, company);
    expect(inbox.newIntroCount).toBe(1);
    expect(inbox.introductions).toMatchObject([{ id: first.id, candidateName: "Rahul", candidateLinkedIn: null }]);
    expect(inbox.suggestions.map(({ candidateName }) => candidateName)).toEqual(expect.arrayContaining(["Mira", "Dev", "Leena"]));
    expect(await candidate.query(api.introductions.getIntro, { id: first.id })).toEqual(first);
    expect(await candidate.query(api.materials.getMaterial, { id: attachment.id })).toMatchObject({ url: "https://portfolio.example/work" });
    expect(await recruiter.query(api.materials.getMaterial, { id: attachment.id, introId: first.id })).toMatchObject({ url: "https://portfolio.example/work" });
    await expect(other.query(api.materials.getMaterial, { id: attachment.id, introId: first.id })).rejects.toThrow(/Access to this company/);
    await expect(other.query(api.introductions.recruiterInbox, company)).rejects.toThrow(/Access to this company/);

    const dashboard = await recruiter.query(api.companies.companyDashboard, company);
    expect(dashboard.overview).toMatchObject({ mode: "fixture", jobPosts: 2, headcountChange: 12, hiresObserved: 2, coverage: "complete" });
    expect(dashboard.peers.map((peer) => peer.name)).toEqual(["Atlas AI", "Meridian Compute"]);
    const sourceId = dashboard.signals.find((signal) => signal.label === "GPU Kernel Engineer")!.evidenceId;
    expect(await recruiter.query(api.companies.getEvidence, { ...company, evidenceId: sourceId })).toMatchObject({
      eventDate: "2026-11-19", mode: "fixture", title: "GPU Kernel Engineer",
    });
    expect(await recruiter.query(api.companies.getEvidence, { ...company, evidenceId: options[0].profileEvidence.id })).toBeNull();
  });

  it("requires a fresh preview and refuses a role whose recruiter is unavailable", async () => {
    const { t, candidate, ids } = await setup();
    const role = { recommendationId: ids.novaRoleId };
    const preview = await candidate.query(api.introductions.previewIntro, role);
    await candidate.mutation(api.profiles.saveProfile, { ...demoPerson, name: "Rahul S." });
    const args = {
      ...role, requestKey: "rahul-stale-test", confirmationToken: preview.confirmationToken,
      sharing: { includeLinkedIn: true, materialIds: [] },
    };
    await expect(candidate.mutation(api.introductions.confirmIntro, args)).rejects.toThrow(/Review it/);
    const fresh = await candidate.query(api.introductions.previewIntro, role);
    await t.run(async (ctx) => {
      const roleRow = await ctx.db.get(ids.novaRoleId);
      await ctx.db.patch(roleRow!.recruiterId!, { active: false });
    });
    await expect(candidate.mutation(api.introductions.confirmIntro, {
      ...args, confirmationToken: fresh.confirmationToken,
    })).rejects.toThrow(/unavailable/);
    expect((await candidate.query(api.introductions.listIntroOptions)).map(({ companyId }) => companyId))
      .not.toContain(ids.novaCompanyId);
  });

  it("withholds a hiring contrast when peer postings are incomplete or unclassified", async () => {
    const { t, ids, recruiter } = await setup();
    const company = { companyId: ids.novaCompanyId };
    await t.run((ctx) => ctx.db.patch(ids.atlasCompanyId, { incompleteKinds: ["departure"] }));
    const partialTalent = await recruiter.query(api.companies.companyDashboard, company);
    expect(partialTalent.peers[0].coverage).toBe("partial");
    expect(partialTalent.hiring.difference?.peerId).toBe(ids.atlasCompanyId);

    const meridianId = partialTalent.peers[1].companyId;
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.atlasCompanyId, { incompleteKinds: ["job_post"] });
      const meridianPosting = await ctx.db.query("signals").withIndex("by_company_and_kind_and_date", (q) =>
        q.eq("companyId", meridianId).eq("kind", "job_post")).first();
      if (!meridianPosting) throw new Error("Expected a Meridian posting.");
      await ctx.db.patch(meridianPosting.evidenceId, { excerpt: "Maintain internal developer tools." });
    });
    const partialJobs = await recruiter.query(api.companies.companyDashboard, company);
    const kernels = partialJobs.hiring.capabilities.find(({ id }) => id === "gpu_kernels");
    expect(kernels?.cells[1]).toMatchObject({ coverage: "partial", observedPostings: 0 });
    expect(partialJobs.hiring.capabilities.find(({ id }) => id === "unclassified")?.cells[2].observedPostings).toBe(1);
    expect(partialJobs.hiring.difference).toBeNull();

    const earlier = await recruiter.query(api.companies.companyDashboard, { ...company, through: "2026-11-18", from: "2026-10-24" });
    expect(earlier.hiring.capabilities.find(({ id }) => id === "gpu_kernels")?.cells[0].observedPostings).toBe(0);
    expect(earlier.hiring.difference).toBeNull();
  });

  it("does not generate an introduction from an empty profile or accept another candidate's material", async () => {
    const { t, candidate, other, ids } = await setup();
    await expect(t.query(api.introductions.listIntroOptions)).rejects.toThrow(/Authentication required/);
    await expect(candidate.mutation(api.profiles.saveProfile, { name: "Rahul", linkedInUrl: "https://example.org/in/rahul" }))
      .rejects.toThrow(/LinkedIn profile URL/);
    expect(await other.mutation(api.profiles.saveProfile, { name: "Example", linkedInUrl: "https://www.linkedin.com/in/example" }))
      .toMatchObject({ status: "awaiting_evidence" });
    expect(await other.query(api.introductions.listIntroOptions)).toEqual([]);
    await other.mutation(api.profiles.saveProfile, {
      name: "Example", linkedInUrl: "https://www.linkedin.com/in/example", workSummary: "Wrote Python spreadsheets for retail."
    });
    expect(await other.query(api.introductions.listIntroOptions)).toEqual([]);
    const material = await other.mutation(api.materials.addLink, {
      kind: "portfolio", label: "Private work", url: "https://portfolio.example/private",
    });
    const preview = await candidate.query(api.introductions.previewIntro, { recommendationId: ids.novaRoleId });
    await expect(candidate.mutation(api.introductions.confirmIntro, {
      recommendationId: ids.novaRoleId, requestKey: "foreign-material", confirmationToken: preview.confirmationToken,
      sharing: { includeLinkedIn: false, materialIds: [material.id] },
    })).rejects.toThrow(/material.*unavailable/);
  });
});
