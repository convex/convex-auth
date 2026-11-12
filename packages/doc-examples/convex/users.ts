import { v } from "convex/values";
import { vAppleProfile } from "@convex-dev/auth/methods/apple/server";
import { vDiscordProfile } from "@convex-dev/auth/methods/discord/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { vGoogleProfile } from "@convex-dev/auth/methods/google/server";
import { internalMutation } from "./_generated/server";

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

export const createUserDiscord = internalMutation({
  args: {
    method: v.object({
      name: v.literal("discord"),
      profile: vDiscordProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});
