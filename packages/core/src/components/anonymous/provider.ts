import { v } from "convex/values";
import { mutation } from "./_generated/server.ts";

/**
 * Create an account connecting an anonymous id to an app user id.
 */
export const createAnonymousAccount = mutation({
  args: { anonymousId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("accounts", args);
    return null;
  },
});
