import { v } from "convex/values";
import { mutation } from "./_generated/server.ts";
import { attestUser, verifyNewUser } from "../custom.ts";

/**
 * Create the account of an anonymous app user that the core just created, and
 * attest the user.
 *
 * `newUser` is the new-user attestation that the core's `createUser`
 * returned. The result has a user attestation, which the sign-in method
 * exchanges for a session.
 *
 * Throws when `newUser` is not a valid new-user attestation of the core.
 */
export const createAnonymousAccount = mutation({
  args: { newUser: v.string() },
  returns: v.object({ attestation: v.string() }),
  handler: async (ctx, { newUser }) => {
    const { userId } = await verifyNewUser(newUser);
    await ctx.db.insert("accounts", { userId });
    return {
      attestation: await attestUser(ctx, { verifiedUserId: userId }),
    };
  },
});
