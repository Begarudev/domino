import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { requireCompanyMember, requireIdentity } from "./access";
import { materialKind, materialView } from "../shared/contract";
import { listOwnerMaterials } from "./matching";

async function checkCapacity(ctx: MutationCtx, owner: string, label: string) {
  if (!label.trim() || label.length > 120) throw new ConvexError("Enter a material name of up to 120 characters.");
  if ((await listOwnerMaterials(ctx, owner)).length >= 10) throw new ConvexError("You can add up to 10 materials.");
}

export const addLink = mutation({
  args: { kind: materialKind, label: v.string(), url: v.string() },
  returns: materialView,
  handler: async (ctx, { kind, label, url }) => {
    const { tokenIdentifier: owner } = await requireIdentity(ctx);
    await checkCapacity(ctx, owner, label);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new ConvexError("Enter a valid HTTPS link.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.href.length > 2_000) {
      throw new ConvexError("Enter a valid HTTPS link.");
    }
    const id = await ctx.db.insert("materials", { owner, kind, label: label.trim(), url: parsed.href });
    return { id, kind, label: label.trim() };
  },
});

export const saveUpload = internalMutation({
  args: { owner: v.string(), kind: materialKind, label: v.string(), storageId: v.id("_storage") },
  returns: materialView,
  handler: async (ctx, { owner, kind, label, storageId }) => {
    await checkCapacity(ctx, owner, label);
    const id = await ctx.db.insert("materials", { owner, kind, label: label.trim(), storageId });
    return { id, kind, label: label.trim() };
  },
});

export const getMaterial = query({
  args: { id: v.id("materials"), introId: v.optional(v.id("intros")) },
  returns: v.union(v.object({ ...materialView.fields, url: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx, { id, introId }) => {
    const { tokenIdentifier } = await requireIdentity(ctx);
    const material = await ctx.db.get(id);
    if (!material) return null;
    if (material.owner !== tokenIdentifier) {
      const intro = introId ? await ctx.db.get(introId) : null;
      if (intro?.owner !== material.owner || !intro.materialIds.includes(id)) return null;
      await requireCompanyMember(ctx, intro.companyId);
    }
    return {
      id,
      kind: material.kind,
      label: material.label,
      url: material.url ?? (material.storageId ? await ctx.storage.getUrl(material.storageId) : null),
    };
  },
});
