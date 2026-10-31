/**
 * Reads of WorkOS directories, as the copy holds them. A directory WorkOS
 * deleted is gone from these reads at once, while its users and groups are
 * removed in batches.
 *
 * @module
 */
import { v } from "convex/values";
import { query } from "./_generated/server.ts";
import { directoryOf } from "./mirror.ts";
import { vDirectory } from "./schema.ts";

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), vDirectory),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directories")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return row === null || "deleted" in row ? null : directoryOf(row);
  },
});

/** An organization's directories. An organization holds a handful. */
export const list = query({
  args: { organizationId: v.string() },
  returns: v.array(vDirectory),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("directories")
      .withIndex("organizationId", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .collect();
    return rows.flatMap((row) => ("deleted" in row ? [] : [directoryOf(row)]));
  },
});
