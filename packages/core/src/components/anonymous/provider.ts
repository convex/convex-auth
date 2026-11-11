import { v } from "convex/values";
import { mutation } from "./_generated/server.ts";

/**
 * Create the account of an anonymous app user.
 */
export const createAnonymousAccount = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("accounts", args);
    return null;
  },
});
