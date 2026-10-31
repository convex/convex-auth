/**
 * Reads of WorkOS organizations, as the copy holds them. They run as part of
 * the app's own queries and mutations, so they react to the sync like any
 * other data.
 *
 * @module
 */
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server.ts";
import { organizationOf, pageOf } from "./mirror.ts";
import { vOrganization } from "./schema.ts";

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), vOrganization),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("organizations")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return row === null || "deleted" in row ? null : organizationOf(row);
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(vOrganization),
  handler: async (ctx, { paginationOpts: { numItems, cursor } }) =>
    await pageOf(
      ctx.db
        .query("organizations")
        .withIndex("id", (q) => (cursor === null ? q : q.gt("id", cursor))),
      numItems,
      (row) => ("deleted" in row ? null : organizationOf(row)),
    ),
});
