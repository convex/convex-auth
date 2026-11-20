import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, query } from "./_generated/server";

/**
 * Create the user row for a new password account and return its id.
 *
 * To keep the demo small, the first user who signs up is the admin. A real
 * app grants roles its own way.
 */
export const createUser = internalMutation({
  args: {
    method: v.object({
      name: v.literal("usernamePassword"),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    const isFirstUser = (await ctx.db.query("users").first()) === null;
    return await ctx.db.insert("users", {
      role: isFirstUser ? "admin" : "member",
    });
  },
});

/**
 * The app's impersonation rule: an admin may act as any user who is not an
 * admin. Convex Auth calls it before it starts an impersonation.
 */
export const authorizeImpersonation = internalMutation({
  args: { impersonatorUserId: v.id("users"), targetUserId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { impersonatorUserId, targetUserId }) => {
    const impersonator = await ctx.db.get("users", impersonatorUserId);
    const target = await ctx.db.get("users", targetUserId);
    // Convex Auth does not check that the users exist. This rule must.
    if (impersonator === null || target === null) {
      return false;
    }
    if (impersonator.role !== "admin" || target.role === "admin") {
      return false;
    }
    // This row commits only if the impersonation starts.
    await ctx.db.insert("impersonationLog", {
      impersonatorUserId,
      targetUserId,
    });
    return true;
  },
});

/** The users an admin may act as. Empty for everybody else. */
export const impersonableUsers = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const user = userId === null ? null : await ctx.db.get("users", userId);
    if (user === null || user.role !== "admin") {
      return [];
    }
    // A demo has few users. A real app paginates.
    const users = await ctx.db.query("users").take(100);
    const members = users.filter((other) => other.role !== "admin");
    return await Promise.all(
      members.map(async (member) => ({
        id: member._id,
        username: await ctx.runQuery(
          components.authUsername.public.getUsername,
          { userId: member._id },
        ),
      })),
    );
  },
});
