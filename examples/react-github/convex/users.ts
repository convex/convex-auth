import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";

/**
 * Create the user row for a new GitHub account and return its id. This example
 * keeps no data in the row, but your app can put a profile here.
 */
export const createUser = internalMutation({
  args: {
    method: v.literal("github"),
    profile: vGithubProfile,
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});

export const getCurrentUser = query({
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
    return { id: user._id };
  },
});
