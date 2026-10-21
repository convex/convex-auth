/**
 * The app-owned callbacks that the sign-in methods configured in `convex/auth.ts` call.
 *
 * A method calls `createUser` the first time it sees an account, which creates the
 * app's user row and returns its id, and then calls the optional `onSignIn` on every
 * sign-in, that first one included.
 *
 * All sign-in methods in this example share one pair of callbacks. GitHub supplies
 * the user's GitHub profile, and `createUser` stores the login from it. The
 * others supply an empty profile. `lastSignedInAt` is maintained by the
 * `onSignIn` hook.
 *
 * @module
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, query } from "./_generated/server";

// The union shape of the configured sign-in methods.
const vProvider = v.union(
  v.object({
    name: v.literal("anonymous"),
    accountId: v.string(),
    profile: v.object({}),
  }),
  v.object({
    name: v.literal("password"),
    accountId: v.string(),
    profile: v.object({}),
  }),
  v.object({
    name: v.literal("github"),
    accountId: v.string(),
    profile: vGithubProfile,
  }),
);

export const createUser = internalMutation({
  args: { provider: vProvider },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert(
      "users",
      args.provider.name === "github"
        ? { githubLogin: args.provider.profile.login }
        : {},
    );
  },
});

// An example of the per-sign-in hook. Here the app records a `lastSignedInAt`
// timestamp for each user on every sign-in, whichever method they used.
export const onSignIn = internalMutation({
  args: { provider: vProvider, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("users", args.userId, { lastSignedInAt: Date.now() });
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
