/**
 * Reads of WorkOS directory users, as the copy holds them. A user's roles are
 * its own `role` and `roles`, as WorkOS assigns them from group memberships.
 *
 * @module
 */
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server.ts";
import { pageOf, userOf } from "./mirror.ts";
import { vDirectoryUser } from "./schema.ts";

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), vDirectoryUser),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("directoryUsers")
      .withIndex("id", (q) => q.eq("id", args.id))
      .unique();
    return row === null || "deleted" in row ? null : userOf(row);
  },
});

/**
 * Directory users, filtered like WorkOS's own listing: by `directory`, by
 * `organization` (and `idpId` within it), by `idpId`, or by `email`. An SSO
 * profile carries the same organization and `idpId`, which is how a signed-in
 * user is matched to their directory user. Give exactly one of these filters.
 */
export const list = query({
  args: {
    directory: v.optional(v.string()),
    organization: v.optional(v.string()),
    idpId: v.optional(v.string()),
    email: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(vDirectoryUser),
  handler: async (ctx, args) => {
    const { directory, organization, idpId } = args;
    const email = args.email?.toLowerCase();
    const { numItems, cursor } = args.paginationOpts;
    const users = ctx.db.query("directoryUsers");
    const given = [directory, organization ?? idpId, email].filter(
      (filter) => filter !== undefined,
    ).length;
    const rows =
      given !== 1
        ? null
        : organization !== undefined && idpId !== undefined
          ? users.withIndex("organizationId_idpId_id", (q) =>
              cursor === null
                ? q.eq("organizationId", organization).eq("idpId", idpId)
                : q
                    .eq("organizationId", organization)
                    .eq("idpId", idpId)
                    .gt("id", cursor),
            )
          : organization !== undefined
            ? users.withIndex("organizationId_id", (q) =>
                cursor === null
                  ? q.eq("organizationId", organization)
                  : q.eq("organizationId", organization).gt("id", cursor),
              )
            : idpId !== undefined
              ? users.withIndex("idpId_id", (q) =>
                  cursor === null
                    ? q.eq("idpId", idpId)
                    : q.eq("idpId", idpId).gt("id", cursor),
                )
              : email !== undefined
                ? users.withIndex("email_id", (q) =>
                    cursor === null
                      ? q.eq("email", email)
                      : q.eq("email", email).gt("id", cursor),
                  )
                : directory !== undefined
                  ? users.withIndex("directoryId_id", (q) =>
                      cursor === null
                        ? q.eq("directoryId", directory)
                        : q.eq("directoryId", directory).gt("id", cursor),
                    )
                  : null;
    if (rows === null) {
      throw new Error(
        "Filter directory users by one of directory, organization, idpId or email",
      );
    }
    return await pageOf(rows, numItems, (row) =>
      "deleted" in row ? null : userOf(row),
    );
  },
});
