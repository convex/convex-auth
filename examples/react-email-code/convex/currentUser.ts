import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";
import { components } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * The signed-in user with their primary email address, or null.
 *
 * The users table holds no address: the query reads the primary address
 * from the authEmail component.
 */
export const loggedInUser = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ id: Id<"users">; email: string | null } | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }

    const email = await ctx.runQuery(
      components.authEmail.verifiedEmails.getPrimaryEmail,
      { userId },
    );
    return { id: user._id, email };
  },
});
