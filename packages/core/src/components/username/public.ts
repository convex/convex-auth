import { mutation, query, QueryCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";
import { Infer, v } from "convex/values";
import {
  isTooLong,
  normalizeUsername,
  setUsernameUserError,
  validateUsernameFormat,
} from "./validation.ts";

const setUsernameResult = v.union(
  v.object({
    success: v.literal(true),
    // The username that this user had before this call, or `null` when the
    // user had no username.
    previousUsername: v.union(v.string(), v.null()),
  }),
  v.object({ success: v.literal(false), userError: setUsernameUserError }),
);
type SetUsernameResult = Infer<typeof setUsernameResult>;

/**
 * Set the username of a user.
 *
 * This function can be used:
 * - to give a username to a new user
 * - to change the username of an existing user (a user has one username at most,
 *   thus a new username replaces the previous one)
 *
 * The function first makes sure that no other user has this username. If a
 * different user has it, the function returns a `USERNAME_TAKEN` user
 * error and changes nothing. When the same user already has this username
 * (possibly with a different case), the function keeps the new spelling
 * and is otherwise a no-op.
 */
export const setUsername = mutation({
  args: { userId: v.string(), username: v.string() },
  returns: setUsernameResult,
  handler: async (ctx, { userId, username }): Promise<SetUsernameResult> => {
    const userError = validateUsernameFormat(username);
    if (userError !== null) {
      return { success: false, userError };
    }

    const usernameNormalized = normalizeUsername(username);
    const conflict = await rowByNormalizedUsername(ctx, usernameNormalized);
    if (conflict !== null && conflict.userId !== userId) {
      return { success: false, userError: { error: "USERNAME_TAKEN" } };
    }

    const existing = await rowByUserId(ctx, userId);
    if (existing !== null) {
      await ctx.db.patch("usernames", existing._id, {
        username,
        usernameNormalized,
      });
      return { success: true, previousUsername: existing.username };
    }
    await ctx.db.insert("usernames", {
      userId,
      username,
      usernameNormalized,
    });
    return { success: true, previousUsername: null };
  },
});

/**
 * Find the user that a username identifies.
 *
 * The lookup ignores the case and the Unicode normalization form of the
 * `username` argument. The function returns `null` when no user has this
 * username.
 */
export const getUserIdByUsername = query({
  args: { username: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { username }): Promise<string | null> => {
    // `setUsername` never stores a username this long.
    if (isTooLong(username)) {
      return null;
    }
    const row = await rowByNormalizedUsername(ctx, normalizeUsername(username));
    return row === null ? null : row.userId;
  },
});

/**
 * Get the username of a user, as the user supplied it.
 *
 * The function returns `null` when the user has no username.
 */
// TODO(nicolas) We could add a `getUsernames` function that takes a list of
// user ids and returns the username of each one, for example to show the
// usernames in a list of users.
export const getUsername = query({
  args: { userId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { userId }): Promise<string | null> => {
    const row = await rowByUserId(ctx, userId);
    return row === null ? null : row.username;
  },
});

/**
 * Delete the username of a user.
 *
 * The function is idempotent: `deleted` is `false` when the user had no
 * username. A user with no username can no longer be found with
 * `getUserIdByUsername`, and the username becomes available again.
 */
export const deleteUsername = mutation({
  args: { userId: v.string() },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, { userId }): Promise<{ deleted: boolean }> => {
    const row = await rowByUserId(ctx, userId);
    if (row === null) {
      return { deleted: false };
    }
    await ctx.db.delete("usernames", row._id);
    return { deleted: true };
  },
});

function rowByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"usernames"> | null> {
  return ctx.db
    .query("usernames")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

function rowByNormalizedUsername(
  ctx: QueryCtx,
  usernameNormalized: string,
): Promise<Doc<"usernames"> | null> {
  return ctx.db
    .query("usernames")
    .withIndex("by_usernameNormalized", (q) =>
      q.eq("usernameNormalized", usernameNormalized),
    )
    .unique();
}
