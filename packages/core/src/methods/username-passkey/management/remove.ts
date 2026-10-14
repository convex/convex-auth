/**
 * The flow that removes a passkey from a signed-in account.
 *
 * A different passkey of the same account must authorize the removal. Thus
 * the flow is one authentication ceremony (`get()`) around the deletion, and
 * the user can never remove their last passkey.
 *
 * ```
 *  Client                                 Provider
 *    │                                       │
 *    │  startRemovePasskey(passkeyId)        │
 *    ├──────────────────────────────────────▶│  start the authentication
 *    │◀──────────────────────────────────────┤  (removed passkey excluded)
 *    │                                       │
 *    ├─▶ navigator.credentials.get()         │
 *    │                                       │
 *    │  finishRemovePasskey(id, assertion)   │
 *    ├──────────────────────────────────────▶│  verify it, delete the passkey
 *    │◀──────────────────────────────────────┤
 *    │                                       │
 * ```
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../../server/userId.ts";
import { REMOVE_PASSKEY_PURPOSE } from "../purposes.ts";
import type { UsernamePasskeyConfig } from "../server.ts";
import { toBase64URL } from "../base64url.ts";
import {
  deletePasskeyUserError,
  finishAuthenticationUserError,
  notSignedInUserError,
  vAuthenticationResponseJSON,
  vPublicKeyCredentialRequestOptionsJSON,
} from "../../../components/passkey/validation.ts";
import { buildAuthenticationOptions } from "../options.ts";

/**
 * The user-facing error when the user tries to remove their only passkey.
 *
 * With a username and a passkey, a user can never remove their last passkey
 * through this provider: a different passkey must authorize the removal.
 * The component stays permissive and does the deletion; the provider makes
 * the policy. A future option could let the app allow the removal, for
 * example when the app knows that the user has a different way to sign in.
 */
// TODO(nicolas) Give the app a way to allow the removal of the last passkey.
const lastPasskeyUserError = v.object({ error: v.literal("LAST_PASSKEY") });

const startRemovePasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    // Ready for the authorization `navigator.credentials.get()` call.
    // The `allowCredentials` list excludes the passkey that goes away.
    options: vPublicKeyCredentialRequestOptionsJSON,
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notSignedInUserError,
      deletePasskeyUserError,
      lastPasskeyUserError,
    ),
  }),
);

export type StartRemovePasskeyResult = Infer<typeof startRemovePasskeyResult>;

const finishRemovePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notSignedInUserError,
      finishAuthenticationUserError,
      deletePasskeyUserError,
    ),
  }),
);

export type FinishRemovePasskeyResult = Infer<typeof finishRemovePasskeyResult>;

export function startRemovePasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      // This is used to exclude the passkey being removed from
      // the list of passkeys suggested by the authenticator.
      passkeyId: v.string(),
    },
    returns: startRemovePasskeyResult,
    handler: async (ctx, { passkeyId }): Promise<StartRemovePasskeyResult> => {
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }

      const passkeys = await ctx.runQuery(
        config.component.registration.listPasskeys,
        { userId },
      );
      const target = passkeys.find(
        (passkey) => passkey.passkeyId === passkeyId,
      );
      if (target === undefined) {
        return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
      }
      if (passkeys.length === 1) {
        return { success: false, userError: { error: "LAST_PASSKEY" } };
      }

      const { challenge, allowCredentials } = await ctx.runMutation(
        config.component.authentication.startAuthentication,
        { purpose: REMOVE_PASSKEY_PURPOSE, userId },
      );
      return {
        success: true,
        options: buildAuthenticationOptions({
          rpId: config.rpId,
          challenge,
          // The filter helps the user only: the browser then does not offer
          // the passkey that goes away. `finishRemovePasskey` refuses such
          // an assertion again, and that check is the enforcement.
          // (`listPasskeys` returns base64url credential IDs, the component
          // start function returns bytes.)
          allowCredentials: allowCredentials.filter(
            (candidate) => toBase64URL(candidate.id) !== target.credentialId,
          ),
        }),
      };
    },
  });
}

export function finishRemovePasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      passkeyId: v.string(),
      response: vAuthenticationResponseJSON,
    },
    returns: finishRemovePasskeyResult,
    handler: async (ctx, args): Promise<FinishRemovePasskeyResult> => {
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }

      const authenticationResult = await ctx.runMutation(
        config.component.authentication.finishAuthentication,
        {
          purpose: REMOVE_PASSKEY_PURPOSE,
          expectedRpId: config.rpId,
          expectedOrigin: config.origin,
          response: args.response,
        },
      );
      if (!authenticationResult.success) {
        return { success: false, userError: authenticationResult.userError };
      }
      if (authenticationResult.userId !== userId) {
        // The identity of the caller changed between `startRemovePasskey`
        // and this call
        console.warn(
          "Rejected a passkey removal because the assertion authenticates a " +
            "different user than the caller. The caller signed in as a " +
            "different user after the `startRemovePasskey` call.",
        );
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
      }
      if (authenticationResult.passkeyId === args.passkeyId) {
        // A passkey cannot authorize its own removal.
        // This should not happen because we exclude the removed passkey
        // from `allowCredentials` in `startRemovePasskey`.
        console.warn(
          "Rejected a passkey removal because the assertion comes from the " +
            "passkey that goes away. Check that `finishRemovePasskey` gets " +
            "the same `passkeyId` as the `startRemovePasskey` call that made " +
            "the challenge.",
        );
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
      }

      // Note that here, we don’t validate that the passkey ID matches the one
      // passed to startRemovePasskey. This is okay: if we reached that point,
      // we know that the passkey’s owner has been re-authenticated, and this is
      // what we actually care about.
      // The reason why startRemovePasskey takes a passkeyId is because we want
      // to exclude the removed passkey from allowCredentials, so that the
      // user’s authenticator doesn’t suggest it. This is a UX improvement,
      // but it’s not necessary from a security point of view.

      const deleteResult = await ctx.runMutation(
        config.component.registration.deletePasskey,
        { userId, passkeyId: args.passkeyId },
      );
      if (!deleteResult.success) {
        return { success: false, userError: deleteResult.userError };
      }
      return { success: true };
    },
  });
}
