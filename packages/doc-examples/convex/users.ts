import { v } from "convex/values";
import { vAppleProfile } from "@convex-dev/auth/methods/apple/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { vGoogleProfile } from "@convex-dev/auth/methods/google/server";
import { internalMutation } from "./_generated/server";
import { vAcmeProfile } from "./acme";

// The `createUser` callback of each sign-in method of `auth.ts`.

export const createUserAnonymous = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("anonymous"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserPassword = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("password"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserEmailPassword = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("emailPassword"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserPasskey = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("passkey"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserGoogle = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("google"),
      profile: vGoogleProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserApple = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("apple"),
      profile: vAppleProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserGithub = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("github"),
      profile: vGithubProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

export const createUserAcme = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("acme"),
      profile: vAcmeProfile,
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});
