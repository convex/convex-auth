/**
 * Reads of WorkOS SSO connections, as the copy holds them.
 *
 * @module
 */
import { v } from "convex/values";
import { query } from "./_generated/server.ts";
import { connectionOf } from "./mirror.ts";
import { vConnection } from "./schema.ts";

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), vConnection),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("connections")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return row === null || "deleted" in row ? null : connectionOf(row);
  },
});

/** An organization's connections. An organization holds a handful. */
export const list = query({
  args: { organizationId: v.string() },
  returns: v.array(vConnection),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("connections")
      .withIndex("organizationId_state", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .collect();
    return rows.flatMap((row) => ("deleted" in row ? [] : [connectionOf(row)]));
  },
});
