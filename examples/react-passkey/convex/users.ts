import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new passkey account and return its id. This
 * example keeps no data in the row, but your app can put a profile here.
 */
export const createUser = internalMutation({
  args: {
    method: v.literal("usernamePasskey"),
    profile: v.object({}),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
