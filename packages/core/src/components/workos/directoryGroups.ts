/**
 * Reads of WorkOS directory groups, as the copy holds them.
 *
 * @module
 */
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server.ts";
import { groupOf, pageOf } from "./mirror.ts";
import { vDirectoryGroup } from "./schema.ts";

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), vDirectoryGroup),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directoryGroups")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return row === null || "deleted" in row ? null : groupOf(row);
  },
});

/** Directory groups, filtered by `directory` or by `organization`. */
export const list = query({
  args: {
    directory: v.optional(v.string()),
    organization: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(vDirectoryGroup),
  handler: async (ctx, { directory, organization, paginationOpts }) => {
    const { numItems, cursor } = paginationOpts;
    const groups = ctx.db.query("directoryGroups");
    const rows =
      directory !== undefined && organization === undefined
        ? groups.withIndex("directoryId_id", (q) =>
            cursor === null
              ? q.eq("directoryId", directory)
              : q.eq("directoryId", directory).gt("id", cursor),
          )
        : organization !== undefined && directory === undefined
          ? groups.withIndex("organizationId_id", (q) =>
              cursor === null
                ? q.eq("organizationId", organization)
                : q.eq("organizationId", organization).gt("id", cursor),
            )
          : null;
    if (rows === null) {
      throw new Error(
        "Filter directory groups by one of directory or organization",
      );
    }
    return await pageOf(rows, numItems, (row) =>
      "deleted" in row ? null : groupOf(row),
    );
  },
});
