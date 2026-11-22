import { v } from "convex/values";
import { query } from "./_generated/server";

export const health = query({
  args: {},
  returns: v.object({ ok: v.literal(true), service: v.literal("domino-recruiting") }),
  handler: async () => ({ ok: true, service: "domino-recruiting" } as const),
});
