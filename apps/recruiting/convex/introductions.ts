import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { getProfile, requireCompanyMember, requireIdentity, requireProfile } from "./access";
import { inboxView, introOptionView, introReceipt, materialView, sharingFields } from "../shared/contract";
import {
  evidenceForProfile, listOwnerMaterials, matchRole, resolveRole, roleFields, searchIntro, toEvidenceView, toMaterialView,
} from "./matching";

const roleArgs = { recommendationId: v.id("roles") };
const introPreview = v.object({
  option: introOptionView,
  candidateName: v.string(),
  linkedInUrl: v.string(),
  message: v.string(),
  confirmationToken: v.string(),
  materials: v.array(materialView),
  existing: v.union(introReceipt, v.null()),
});

function receipt(intro: Doc<"intros">) {
  return { id: intro._id, companyId: intro.companyId, roleId: intro.roleId, status: "delivered" as const, deliveredAt: intro.deliveredAt };
}

async function resolveOption(ctx: QueryCtx, profile: Doc<"profiles">, role: Doc<"roles">, evidence: Doc<"evidence">[]) {
  const resolved = await resolveRole(ctx, role);
  if (!resolved) return null;
  const match = matchRole(resolved, evidence);
  if (!match) return null;
  return {
    ...roleFields(resolved),
    recommendationId: role._id,
    recipient: { name: resolved.recruiter.name, title: resolved.recruiter.title },
    reason: match.reason,
    jobEvidence: toEvidenceView(resolved.jobEvidence),
    profileEvidence: toEvidenceView(match.profileEvidence),
    score: match.score,
    message: `${profile.name} is interested in ${role.title} at ${resolved.company.name}. ${match.reason}`,
    confirmationToken: [profile.name, resolved.company.name, role.title, resolved.recruiter.name, resolved.recruiter.title, profile.updatedAt,
      role._id, resolved.recruiter._id, resolved.jobEvidence._id, match.profileEvidence._id].join("|"),
  };
}

function publicOption(option: NonNullable<Awaited<ReturnType<typeof resolveOption>>>) {
  const { score: _score, message: _message, confirmationToken: _confirmationToken, ...view } = option;
  return view;
}

async function requireOption(ctx: QueryCtx, profile: Doc<"profiles">, roleId: Id<"roles">) {
  const role = await ctx.db.get(roleId);
  const option = role ? await resolveOption(ctx, profile, role, await evidenceForProfile(ctx, profile)) : null;
  if (!option) throw new ConvexError("An introduction is unavailable for this role.");
  return option;
}

export const listIntroOptions = query({
  args: {},
  returns: v.array(introOptionView),
  handler: async (ctx) => {
    const { tokenIdentifier } = await requireIdentity(ctx);
    const profile = await getProfile(ctx, tokenIdentifier);
    if (!profile) return [];
    const evidence = await evidenceForProfile(ctx, profile);
    if (!evidence.length) return [];
    const roles = await ctx.db.query("roles").withIndex("by_active", (q) => q.eq("active", true)).take(100);
    const options = (await Promise.all(roles.map((role) => resolveOption(ctx, profile, role, evidence))))
      .filter((option) => option !== null)
      .sort((left, right) => right.score - left.score || left.companyName.localeCompare(right.companyName));
    const uniqueCompanies = new Set<Id<"companies">>();
    return options.filter((option) => {
      if (uniqueCompanies.has(option.companyId)) return false;
      uniqueCompanies.add(option.companyId);
      return true;
    }).slice(0, 12).map(publicOption);
  },
});

export const previewIntro = query({
  args: roleArgs,
  returns: introPreview,
  handler: async (ctx, { recommendationId }) => {
    const { tokenIdentifier } = await requireIdentity(ctx);
    const candidate = await requireProfile(ctx, tokenIdentifier);
    const [option, materials, existing] = await Promise.all([
      requireOption(ctx, candidate, recommendationId),
      listOwnerMaterials(ctx, tokenIdentifier),
      searchIntro(ctx, candidate._id, recommendationId),
    ]);
    return {
      option: publicOption(option),
      candidateName: candidate.name,
      linkedInUrl: candidate.linkedInUrl,
      message: option.message,
      confirmationToken: option.confirmationToken,
      materials: materials.map(toMaterialView),
      existing: existing ? receipt(existing) : null,
    };
  },
});

export const confirmIntro = mutation({
  args: { ...roleArgs, requestKey: v.string(), confirmationToken: v.string(), sharing: v.object(sharingFields) },
  returns: introReceipt,
  handler: async (ctx, { recommendationId, requestKey, confirmationToken, sharing }) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) throw new ConvexError("A valid introduction request key is required.");
    const { tokenIdentifier } = await requireIdentity(ctx);
    const candidate = await requireProfile(ctx, tokenIdentifier);
    const request = await ctx.db.query("intros")
      .withIndex("by_candidate_and_request_key", (q) => q.eq("candidateId", candidate._id).eq("requestKey", requestKey))
      .unique();
    if (request && request.roleId !== recommendationId) throw new ConvexError("That request key was used for another role.");
    const existing = request ?? await searchIntro(ctx, candidate._id, recommendationId);
    if (existing) return receipt(existing);

    const materialIds = [...new Set(sharing.materialIds)];
    if (materialIds.length > 10) throw new ConvexError("Choose up to 10 materials to share.");
    const materials = await Promise.all(materialIds.map((id) => ctx.db.get(id)));
    if (materials.some((material) => material?.owner !== tokenIdentifier)) {
      throw new ConvexError("One of the selected materials is unavailable.");
    }
    const option = await requireOption(ctx, candidate, recommendationId);
    if (option.confirmationToken !== confirmationToken) {
      throw new ConvexError("The introduction changed. Review it before sending.");
    }
    const deliveredAt = Date.now();
    const id = await ctx.db.insert("intros", {
      candidateId: candidate._id,
      owner: tokenIdentifier,
      roleId: recommendationId,
      companyId: option.companyId,
      requestKey,
      candidateName: candidate.name,
      candidateLinkedIn: sharing.includeLinkedIn ? candidate.linkedInUrl : null,
      matchExcerpt: option.profileEvidence.excerpt,
      message: option.message,
      jobEvidenceId: option.jobEvidence.id,
      materialIds,
      deliveredAt,
    });
    return { id, roleId: recommendationId, companyId: option.companyId, status: "delivered" as const, deliveredAt };
  },
});

export const getIntro = query({
  args: { id: v.id("intros") },
  returns: v.union(introReceipt, v.null()),
  handler: async (ctx, { id }) => {
    const { tokenIdentifier } = await requireIdentity(ctx);
    const intro = await ctx.db.get(id);
    return intro?.owner === tokenIdentifier ? receipt(intro) : null;
  },
});

export const recruiterCompanies = query({
  args: {},
  returns: v.array(v.object({ companyId: v.id("companies"), name: v.string() })),
  handler: async (ctx) => {
    const { tokenIdentifier } = await requireIdentity(ctx);
    const memberships = await ctx.db.query("recruiters").withIndex("by_owner", (q) => q.eq("owner", tokenIdentifier)).take(20);
    const companies = await Promise.all(memberships.filter((member) => member.active).map((member) => ctx.db.get(member.companyId)));
    return companies.filter((company) => company !== null).map((company) => ({ companyId: company._id, name: company.name }));
  },
});

export const recruiterInbox = query({
  args: { companyId: v.id("companies") },
  returns: inboxView,
  handler: async (ctx, { companyId }) => {
    await requireCompanyMember(ctx, companyId);
    const company = await ctx.db.get(companyId);
    if (!company) throw new ConvexError("Company is unavailable.");
    const intros = await ctx.db.query("intros").withIndex("by_company_and_delivered_at", (q) => q.eq("companyId", companyId)).order("desc").take(50);
    const rows = await Promise.all(intros.map(async (intro) => {
      const [role, evidence, materials] = await Promise.all([
        ctx.db.get(intro.roleId),
        ctx.db.get(intro.jobEvidenceId),
        Promise.all(intro.materialIds.map((id) => ctx.db.get(id))),
      ]);
      if (!role || !evidence) return null;
      return {
        ...receipt(intro),
        companyName: company.name,
        roleTitle: role.title,
        candidateName: intro.candidateName,
        candidateLinkedIn: intro.candidateLinkedIn,
        matchExcerpt: intro.matchExcerpt,
        message: intro.message,
        jobEvidence: toEvidenceView(evidence),
        materials: materials.filter((row): row is Doc<"materials"> => row !== null && row.owner === intro.owner).map(toMaterialView),
        opened: intro.openedAt !== undefined,
      };
    }));
    const profiles = await ctx.db.query("profiles")
      .withIndex("by_discoverable_and_updated_at", (q) => q.eq("discoverable", true)).order("desc").take(50);
    const roles = await ctx.db.query("roles")
      .withIndex("by_company_and_active", (q) => q.eq("companyId", companyId).eq("active", true)).take(20);
    const resolved = (await Promise.all(roles.map((role) => resolveRole(ctx, role)))).filter((role) => role !== null);
    const suggestions = (await Promise.all(profiles.map(async (profile) => {
      const evidence = await evidenceForProfile(ctx, profile);
      const ranked = resolved.flatMap((role) => {
        const match = matchRole(role, evidence);
        return match ? [{ role, match }] : [];
      }).sort((a, b) => b.match.score - a.match.score);
      const first = ranked[0];
      if (!first || await searchIntro(ctx, profile._id, first.role.role._id)) return null;
      return {
        ...roleFields(first.role),
        candidateId: profile._id,
        candidateName: profile.name,
        reason: first.match.reason,
        matchExcerpt: first.match.profileEvidence.excerpt,
        jobEvidence: toEvidenceView(first.role.jobEvidence),
        score: first.match.score,
      };
    }))).filter((row) => row !== null).sort((a, b) => b.score - a.score)
      .slice(0, 20).map(({ score: _score, ...row }) => row);
    return {
      companyId,
      companyName: company.name,
      newIntroCount: intros.filter((intro) => intro.openedAt === undefined).length,
      introductions: rows.filter((row) => row !== null),
      suggestions,
    };
  },
});

export const markIntroOpened = mutation({
  args: { companyId: v.id("companies"), introId: v.id("intros") },
  returns: v.null(),
  handler: async (ctx, { companyId, introId }) => {
    await requireCompanyMember(ctx, companyId);
    const intro = await ctx.db.get(introId);
    if (intro?.companyId !== companyId) throw new ConvexError("Introduction is unavailable.");
    if (intro.openedAt === undefined) await ctx.db.patch(introId, { openedAt: Date.now() });
    return null;
  },
});
