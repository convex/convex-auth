import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { vEmailCodeProfile } from "@convex-dev/auth/methods/email-code/server";

export const createUser = internalMutation({
  args: {
    method: v.object({
      name: v.literal("emailCode"),
      // The address that received the code. The email component keeps it as
      // the primary email address of the user, thus the users table does not.
      profile: vEmailCodeProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
