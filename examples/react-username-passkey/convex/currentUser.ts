import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";
import { components } from "./_generated/api";

/**
 * The currently signed-in user, or null.
 *
 * Demonstrates an authenticated query.
 */
export const loggedInUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }
    const username = await ctx.runQuery(
      components.authUsername.public.getUsername,
      { userId },
    );
    if (username === null) {
      // Every user signs up with a username, so this must not occur.
      throw new Error(`User ${userId} unexpectedly has no username`);
    }

    return { id: user._id, username };
  },
});
