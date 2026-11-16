import { v } from "convex/values";
import { vAppleProfile } from "@convex-dev/auth/methods/apple/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { vGoogleProfile } from "@convex-dev/auth/methods/google/server";
import { requireRecentAuthentication } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation } from "./_generated/server";

// The `createUser` callback of each sign-in method of `auth.ts`.

export const createUserPassword = internalMutation({
  args: {
    method: v.object({
      name: v.literal("usernamePassword"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserEmailPassword = internalMutation({
  args: {
    method: v.object({
      name: v.literal("emailPassword"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserPasskey = internalMutation({
  args: {
    method: v.object({
      name: v.literal("usernamePasskey"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserGoogle = internalMutation({
  args: {
    method: v.object({
      name: v.literal("google"),
      profile: vGoogleProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserApple = internalMutation({
  args: {
    method: v.object({
      name: v.literal("apple"),
      profile: vAppleProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserGithub = internalMutation({
  args: {
    method: v.object({
      name: v.literal("github"),
      profile: vGithubProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

// The `getUserName` callback of the `passkey` method of `passkey.ts`.
export const passkeyUserName = internalQuery({
  args: { userId: v.id("users") },
  returns: v.object({ name: v.string(), displayName: v.string() }),
  handler: async (_ctx, { userId }) => ({ name: userId, displayName: userId }),
});

// A sensitive action, for the examples of `requireRecentAuthentication`.
export const deleteAccount = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const { userId } = await requireRecentAuthentication(ctx, {
      maxAgeSeconds: 5 * 60,
    });
    await ctx.db.delete("users", userId);
    return null;
  },
});
