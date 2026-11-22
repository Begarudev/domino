import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx, QueryCtx } from "./_generated/server";

export async function requireIdentity(ctx: Pick<ActionCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Authentication required.");
  return identity;
}

export async function getProfile(ctx: QueryCtx, owner: string) {
  return ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("owner", owner)).unique();
}

export async function requireProfile(ctx: QueryCtx, owner: string) {
  const profile = await getProfile(ctx, owner);
  if (!profile) throw new ConvexError("Save your profile to continue.");
  return profile;
}

export async function requireCompanyMember(ctx: QueryCtx, companyId: Id<"companies">) {
  const { tokenIdentifier } = await requireIdentity(ctx);
  const member = await ctx.db.query("recruiters")
    .withIndex("by_company_and_owner", (q) => q.eq("companyId", companyId).eq("owner", tokenIdentifier))
    .unique();
  if (!member?.active) throw new ConvexError("Access to this company is required.");
  return member;
}

export function identityKey(issuer: string, subject: string): string {
  return `${issuer}|${subject}`;
}
