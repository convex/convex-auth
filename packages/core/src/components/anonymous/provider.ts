import { v } from "convex/values";
import { mutation } from "./_generated/server.ts";

/**
 * Record an anonymous account: the identity the provider minted for this
 * sign-in and the app user the core created for it.
 */
export const createAnonymousAccount = mutation({
  args: { anonymousId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("accounts", args);
    return null;
  },
});
