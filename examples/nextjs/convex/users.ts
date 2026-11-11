/**
 * The app-owned callbacks that the sign-in methods configured in `convex/auth.ts` call.
 *
 * A method calls `createUser` the first time it sees an account, which creates the
 * app's user row and returns its id, and then calls the optional `onSignIn` on every
 * sign-in, that first one included.
 *
 * The anonymous and username-password methods share one `createUser`, since
 * both supply an empty profile. GitHub supplies the user's GitHub profile, and
 * `createUserGithub` stores the login from it. All sign-in methods share one
 * `onSignIn` hook, which maintains `lastSignedInAt`.
 *
 * @module
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, query } from "./_generated/server";

// A Convex function takes an object as its args, not a union of objects. Thus
// a callback that serves several sign-in methods takes a union of the method
// names as `method`, and a union of their profiles as `profile`.

// The `createUser` of the anonymous and the username-password methods. Both
// supply an empty profile.
export const createUser = internalMutation({
  args: {
    method: v.union(v.literal("anonymous"), v.literal("usernamePassword")),
    profile: v.object({}),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});

// The `createUser` of the GitHub method, which stores the GitHub login.
export const createUserGithub = internalMutation({
  args: {
    method: v.literal("github"),
    profile: vGithubProfile,
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { githubLogin: args.profile.login });
  },
});

// An example of the per-sign-in hook. Here the app records a `lastSignedInAt`
// timestamp for each user on every sign-in, whichever method they used.
export const onSignIn = internalMutation({
  args: {
    method: v.union(
      v.literal("anonymous"),
      v.literal("usernamePassword"),
      v.literal("github"),
    ),
    profile: v.union(v.object({}), vGithubProfile),
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("users", args.userId, { lastSignedInAt: Date.now() });
    return null;
  },
});

/**
 * The currently signed-in user, or null. Demonstrates an authenticated query
 * that works both when preloaded on the server and live on the client.
 */
export const loggedInUser = query({
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
    const username = await ctx.runQuery(
      components.authUsername.public.getUsername,
      { userId },
    );
    return { id: user._id, username, githubLogin: user.githubLogin ?? null };
  },
});
