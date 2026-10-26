/**
 * Renaming a passkey of a signed-in account.
 *
 * A rename changes only the display label of the passkey in the settings
 * list, so no re-authentication ceremony guards it: the session of the
 * caller is enough.
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../../server/userId.ts";
import type { UsernamePasskeyConfig } from "../server.ts";
import {
  notSignedInUserError,
  renamePasskeyUserError,
} from "../../../components/passkey/validation.ts";

const renamePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(notSignedInUserError, renamePasskeyUserError),
  }),
);

export type RenamePasskeyResult = Infer<typeof renamePasskeyResult>;

export function renamePasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      passkeyId: v.string(),
      // A short label for the settings list ("MacBook Touch ID"); at most
      // 50 characters (see `passkeyNameIsValid`).
      name: v.string(),
    },
    returns: renamePasskeyResult,
    handler: async (ctx, args): Promise<RenamePasskeyResult> => {
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }
      return await ctx.runMutation(
        config.component.registration.renamePasskey,
        { userId, passkeyId: args.passkeyId, name: args.name },
      );
    },
  });
}
