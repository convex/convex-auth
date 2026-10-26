/**
 * Allows logged-in users to see the passkeys set up on their account.
 *
 * @module
 */

import { queryGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../../server/userId.ts";
import type { UsernamePasskeyConfig } from "../server.ts";
import { notSignedInUserError } from "../../../components/passkey/validation.ts";

/**
 * The passkey metadata shown to the user when managing their passkeys.
 */
const passkeyMetadata = v.object({
  passkeyId: v.string(),
  name: v.optional(v.string()),
  credentialId: v.string(), // as base64url
  createdAt: v.number(),
});

const listPasskeysResult = v.union(
  v.object({ success: v.literal(true), passkeys: v.array(passkeyMetadata) }),
  v.object({ success: v.literal(false), userError: notSignedInUserError }),
);

export type ListPasskeysResult = Infer<typeof listPasskeysResult>;

export function listPasskeys(config: UsernamePasskeyConfig) {
  return queryGeneric({
    args: {},
    returns: listPasskeysResult,
    handler: async (ctx): Promise<ListPasskeysResult> => {
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }
      const passkeys = await ctx.runQuery(
        config.component.registration.listPasskeys,
        { userId },
      );
      return { success: true, passkeys };
    },
  });
}
