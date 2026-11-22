import assert from "node:assert/strict";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import { demoPerson } from "../shared/contract";
import { localDeploymentUrl, runConvex } from "./local-deployment";

const url = localDeploymentUrl();
if (!process.env.DOMINO_DEMO_CANDIDATE_TOKEN || !process.env.DOMINO_DEMO_RECRUITER_TOKEN || !process.env.DOMINO_DEMO_OTHER_RECRUITER_TOKEN) {
  throw new Error("Run bun run demo:setup before the local acceptance test.");
}
runConvex("run", "demo:seed", JSON.stringify({ reset: true }));
const candidate = new ConvexHttpClient(url);
const recruiterHttp = new ConvexHttpClient(url);
const outsider = new ConvexHttpClient(url);
candidate.setAuth(process.env.DOMINO_DEMO_CANDIDATE_TOKEN);
recruiterHttp.setAuth(process.env.DOMINO_DEMO_RECRUITER_TOKEN);
outsider.setAuth(process.env.DOMINO_DEMO_OTHER_RECRUITER_TOKEN);
const secondClick = new ConvexHttpClient(url);
secondClick.setAuth(process.env.DOMINO_DEMO_CANDIDATE_TOKEN);
const recruiter = new ConvexClient(url, { unsavedChangesWarning: false });
recruiter.setAuth(async () => process.env.DOMINO_DEMO_RECRUITER_TOKEN ?? null);

try {
  assert.equal((await candidate.query(api.system.health)).ok, true);
  assert.equal((await candidate.mutation(api.profiles.saveProfile, demoPerson)).status, "ready");
  const options = await candidate.query(api.introductions.listIntroOptions);
  assert.equal(options.length, 3);
  const nova = options[0];
  assert.equal(nova.companyName, "Nova Labs");
  assert.equal(nova.roleTitle, "Inference Platform Engineer");
  const attachment = await candidate.action(api.uploads.addFile, {
    kind: "work_sample", fileName: "Serving notes.txt", mimeType: "text/plain",
    base64: Buffer.from("Load test notes for model serving.").toString("base64"),
  });
  const preview = await candidate.query(api.introductions.previewIntro, { recommendationId: nova.recommendationId });
  assert.equal(preview.materials[0].id, attachment.id);
  const company = { companyId: nova.companyId };
  assert.equal((await recruiterHttp.query(api.introductions.recruiterInbox, company)).newIntroCount, 0);
  type Inbox = FunctionReturnType<typeof api.introductions.recruiterInbox>;
  let subscribed = () => {};
  const inboxUpdate = new Promise<Inbox>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Recruiter inbox did not receive a live update.")), 10_000);
    subscribed = recruiter.onUpdate(api.introductions.recruiterInbox, company, (inbox) => {
      if (inbox.newIntroCount === 0) return;
      clearTimeout(timeout);
      resolve(inbox);
    }, (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  try {
    const impression = {
      recommendationId: nova.recommendationId,
      requestKey: "rahul-nova-local",
      confirmationToken: preview.confirmationToken,
      sharing: { includeLinkedIn: false, materialIds: [attachment.id] },
    };
    const [first, again, inbox] = await Promise.all([
      candidate.mutation(api.introductions.confirmIntro, impression),
      secondClick.mutation(api.introductions.confirmIntro, impression),
      inboxUpdate,
    ]);
    assert.equal(again.id, first.id);
    assert.equal(inbox.introductions.length, 1);
    assert.equal(inbox.introductions[0].candidateName, "Rahul");
    assert.equal(inbox.introductions[0].candidateLinkedIn, null);
    assert.ok(inbox.suggestions.length >= 3);
    assert.equal((await candidate.query(api.introductions.getIntro, { id: first.id }))?.id, first.id);
    await assert.rejects(outsider.query(api.introductions.recruiterInbox, company), /Access to this company/);
    await assert.rejects(outsider.query(api.materials.getMaterial, { id: attachment.id, introId: first.id }), /Access to this company/);
    const shared = await recruiterHttp.query(api.materials.getMaterial, { id: attachment.id, introId: first.id });
    assert.ok(shared?.url);
    assert.equal(await (await fetch(shared.url)).text(), "Load test notes for model serving.");
    await recruiterHttp.mutation(api.introductions.markIntroOpened, { ...company, introId: first.id });
    assert.equal((await recruiterHttp.query(api.introductions.recruiterInbox, company)).newIntroCount, 0);
  } finally {
    subscribed();
  }
  const dashboard = await recruiterHttp.query(api.companies.companyDashboard, company);
  assert.deepEqual(dashboard.peers.map(({ name }) => name), ["Atlas AI", "Meridian Compute"]);
  assert.equal(dashboard.overview.jobPosts, 2);
  assert.equal(dashboard.overview.headcountChange, 12);
  assert.equal(dashboard.overview.hiresObserved, 2);
  const kernelSignal = dashboard.signals.find(({ label }) => label === "GPU Kernel Engineer");
  assert.ok(kernelSignal);
  const source = await recruiterHttp.query(api.companies.getEvidence, { ...company, evidenceId: kernelSignal.evidenceId });
  assert.equal(source?.mode, "fixture");
  assert.equal(source.eventDate, "2026-11-19");
  console.log("Local Convex passed authenticated onboarding, uploads, recommendations, concurrent intro delivery, reactive recruiter inbox, tenant isolation, and dated peer evidence.");
} finally {
  await recruiter.close();
  runConvex("run", "demo:seed", JSON.stringify({ reset: true }));
}
