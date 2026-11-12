import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { vAppleProfile } from "@convex-dev/auth/methods/apple/server";

/**
 * Create the user row for a new Apple account and return its id.
 *
 * This is the one sign-in where Apple sends a name, so it is stored now.
 * Treat it as untrusted text the user typed: it reached us through the
 * browser rather than from Apple directly.
 */
export const createUser = internalMutation({
  args: {
    method: v.object({
      name: v.literal("apple"),
      profile: vAppleProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", {
      name: args.method.profile.name,
      email: args.method.profile.email,
    });
  },
});

/**
 * Runs on every sign-in, the first one included.
 *
 * Apple sends the name with the first authorization only, and `createUser`
 * stores it there. This fills in a name for an account created without one,
 * which happens when the user removes the app from their Apple Account and
 * authorizes again.
 */
export const onSignIn = internalMutation({
  args: {
    method: v.object({
      name: v.literal("apple"),
      profile: vAppleProfile,
    }),
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { name } = args.method.profile;
    if (name === undefined) {
      return null;
    }
    const user = await ctx.db.get("users", args.userId);
    if (user !== null && user.name === undefined) {
      await ctx.db.patch("users", args.userId, { name });
    }
    return null;
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
    return { id: user._id, name: user.name, email: user.email };
  },
});
