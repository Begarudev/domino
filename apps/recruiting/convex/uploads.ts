"use node";

import { ConvexError, v } from "convex/values";
import { requireIdentity } from "./access";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { materialKind, materialView } from "../shared/contract";

const maxBytes = 2 * 1024 * 1024;

export const addFile = action({
  args: {
    kind: materialKind,
    fileName: v.string(),
    mimeType: v.union(v.literal("application/pdf"), v.literal("text/plain")),
    base64: v.string(),
  },
  returns: materialView,
  handler: async (ctx, { kind, fileName, mimeType, base64 }): Promise<typeof materialView.type> => {
    const { tokenIdentifier: owner } = await requireIdentity(ctx);
    if (base64.length > 4 * Math.ceil(maxBytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new ConvexError("Choose a PDF or text file up to 2 MB.");
    }
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > maxBytes) throw new ConvexError("Choose a PDF or text file up to 2 MB.");
    if (mimeType === "application/pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") {
      throw new ConvexError("The file does not appear to be a PDF.");
    }
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    try {
      return await ctx.runMutation(internal.materials.saveUpload, { owner, kind, label: fileName, storageId });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
  },
});
