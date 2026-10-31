import { getAuthUserId } from "@convex-dev/auth/server";
import {
  vWorkosProfile,
  type WorkosDirectoryUser,
} from "@convex-dev/auth/methods/workos/server";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx, query } from "./_generated/server";

const vProvider = v.object({
  name: v.literal("workos"),
  accountId: v.string(),
  profile: vWorkosProfile,
});

/** Create the user row for a new SSO account and return its id. */
export const createUser = internalMutation({
  args: { provider: vProvider },
  returns: v.id("users"),
  handler: async (ctx, { provider: { profile } }) => {
    return await ctx.db.insert("users", {
      email: profile.email,
      organizationId: profile.organizationId,
      idpId: profile.idpId,
    });
  },
});

/**
 * Refuse a sign-in the customer's directory has deprovisioned, which can come
 * before the identity provider stops signing the user in.
 */
export const onSignIn = internalMutation({
  args: { userId: v.id("users"), provider: vProvider },
  returns: v.null(),
  handler: async (ctx, { provider: { profile } }) => {
    if (profile.organizationId === undefined) return null;
    const entries = await ctx.runQuery(
      components.authWorkos.directoryUsers.list,
      {
        organization: profile.organizationId,
        idpId: profile.idpId,
        paginationOpts: { numItems: 10, cursor: null },
      },
    );
    if (entries.page.some((entry) => entry.state !== "active")) {
      throw new ConvexError("Your organization has deactivated this account.");
    }
    return null;
  },
});

/** Mark the directory user's app users and sign them out everywhere. */
export async function deprovision(ctx: MutationCtx, user: WorkosDirectoryUser) {
  const users = await ctx.db
    .query("users")
    .withIndex("organizationId_idpId", (q) =>
      q.eq("organizationId", user.organizationId).eq("idpId", user.idpId),
    )
    .collect();
  for (const row of users) {
    await ctx.db.patch("users", row._id, { deprovisioned: true });
    await ctx.scheduler.runAfter(0, internal.users.revoke, { userId: row._id });
  }
}

/** Revoke a batch of the user's sessions, and queue the next. */
export const revoke = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const { more } = await ctx.runMutation(
      components.auth.public.revokeUserSessions,
      { userId },
    );
    if (more)
      await ctx.scheduler.runAfter(0, internal.users.revoke, { userId });
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
    return { id: user._id, email: user.email };
  },
});
