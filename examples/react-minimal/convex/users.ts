import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new anonymous account and return its id.
 *
 * Every anonymous sign-in establishes a new account, so this runs on every
 * anonymous sign-in.
 */
export const createUser = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("anonymous"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
