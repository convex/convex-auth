/**
 * The flow that adds a passkey to a signed-in account.
 *
 * For security purposes, the user must prove again that they
 * hold a pre-existing passkey of the account.
 *
 * ```
 *  Client                             Method
 *    │                                   │
 *    │  startAddPasskey()                │
 *    ├──────────────────────────────────▶│  start the re-authentication
 *    │◀──────────────────────────────────┤
 *    │                                   │
 *    ├─▶ navigator.credentials.get()     │
 *    │                                   │
 *    │  verifyAddPasskey(assertion)      │
 *    ├──────────────────────────────────▶│  verify it, start the registration
 *    │◀──────────────────────────────────┤
 *    │                                   │
 *    ├─▶ navigator.credentials.create()  │
 *    │                                   │
 *    │  finishAddPasskey(attestation)    │
 *    ├──────────────────────────────────▶│  store the new passkey
 *    │◀──────────────────────────────────┤
 *    │                                   │
 * ```
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../../server/userId.ts";
import { ADD_PASSKEY_PURPOSE } from "../purposes.ts";
import type { UsernamePasskeyConfig } from "../server.ts";
import {
  finishAuthenticationUserError,
  finishRegistrationUserError,
  notSignedInUserError,
  vAuthenticationResponseJSON,
  vPublicKeyCredentialCreationOptionsJSON,
  vPublicKeyCredentialRequestOptionsJSON,
  vRegistrationResponseJSON,
} from "../../../components/passkey/validation.ts";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
} from "../options.ts";
import { defaultPasskeyName } from "../aaguids.ts";

/**
 * The largest number of passkeys that one user can hold.
 *
 * Each passkey of the user goes into the `allowCredentials` list of every
 * sign-in and into the `excludeCredentials` list of every registration, thus
 * an unbounded list grows the payload of every ceremony. The limit is far
 * above the number of authenticators that a person uses, and the user can
 * remove a passkey to make room for a new one.
 *
 * The component stays permissive; the method makes the policy, like it does
 * for the removal of the last passkey.
 */
export const MAX_PASSKEYS_PER_USER = 20;

/**
 * The user-facing error when the user already holds the largest number of
 * passkeys.
 */
const tooManyPasskeysUserError = v.object({
  error: v.literal("TOO_MANY_PASSKEYS"),
});

const startAddPasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    // Ready for the re-authentication `navigator.credentials.get()` call.
    options: vPublicKeyCredentialRequestOptionsJSON,
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(notSignedInUserError, tooManyPasskeysUserError),
  }),
);

export type StartAddPasskeyResult = Infer<typeof startAddPasskeyResult>;

const verifyAddPasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    options: vPublicKeyCredentialCreationOptionsJSON,
  }),
  v.object({
    success: v.literal(false),
    // `PROTOCOL_ERROR` also covers an assertion that authenticates a
    // different user than the caller. See the check in `verifyAddPasskey`.
    userError: v.union(notSignedInUserError, finishAuthenticationUserError),
  }),
);

export type VerifyAddPasskeyResult = Infer<typeof verifyAddPasskeyResult>;

const finishAddPasskeyResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notSignedInUserError,
      finishRegistrationUserError,
      tooManyPasskeysUserError,
    ),
  }),
);

export type FinishAddPasskeyResult = Infer<typeof finishAddPasskeyResult>;

export function startAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {},
    returns: startAddPasskeyResult,
    handler: async (ctx): Promise<StartAddPasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }
      const passkeys = await ctx.runQuery(
        config.component.registration.listPasskeys,
        { userId },
      );

      if (passkeys.length >= MAX_PASSKEYS_PER_USER) {
        return { success: false, userError: { error: "TOO_MANY_PASSKEYS" } };
      }

      const { challenge, allowCredentials } = await ctx.runMutation(
        config.component.authentication.startAuthentication,
        { purpose: ADD_PASSKEY_PURPOSE, userId },
      );
      if (allowCredentials.length === 0) {
        // TODO: When auth flows are more composable, we should just ask the user to reauthenticate another way.
        throw new Error(
          "The signed-in user has no passkey. They can’t add a new passkey, because we can’t ask them to reauthenticate.",
        );
      }
      return {
        success: true,
        options: buildAuthenticationOptions({
          rpId: config.rpId,
          challenge,
          allowCredentials,
        }),
      };
    },
  });
}

export function verifyAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      response: vAuthenticationResponseJSON,
    },
    returns: verifyAddPasskeyResult,
    handler: async (ctx, args): Promise<VerifyAddPasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }

      const authenticationResult = await ctx.runMutation(
        config.component.authentication.finishAuthentication,
        {
          purpose: ADD_PASSKEY_PURPOSE,
          expectedRpId: config.rpId,
          expectedOrigin: config.origin,
          response: args.response,
        },
      );
      if (!authenticationResult.success) {
        return { success: false, userError: authenticationResult.userError };
      }
      if (authenticationResult.userId !== userId) {
        // The identity of the caller changed between `startAddPasskey` and
        // this call: the challenge stays bound to the user who started the
        // ceremony, and that user is no longer the caller. A sign-out and a
        // new sign-in, or a race with a sign-in in a different tab, both do
        // this. The result is a `PROTOCOL_ERROR`, which keeps the challenge
        // burned and thus prevents a replay of the assertion.
        console.warn(
          "Rejected an addition of a passkey because the assertion " +
            "authenticates a different user than the caller. The caller " +
            "signed in as a different user after the `startAddPasskey` call.",
        );
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
      }

      const { challenge, userHandle, excludeCredentials } =
        await ctx.runMutation(
          config.component.registration.startRegistrationForExistingUser,
          { verifiedUserId: userId },
        );
      const username = await ctx.runQuery(
        config.usernameComponent.public.getUsername,
        { userId },
      );
      if (username === null) {
        // WebAuthn requires `user.name` and `user.displayName`, and the
        // browser keeps them in its passkey manager for the life of the
        // passkey. Only the app can remove a username, so this is an app
        // state the flow cannot serve, not a user error. Throwing rolls
        // back the registration challenge.
        throw new Error(
          "The signed-in user has no username. Give them a username before they add a passkey.",
        );
      }
      return {
        success: true,
        options: buildRegistrationOptions({
          rpId: config.rpId,
          rpName: config.rpName,
          challenge,
          userHandle,
          // What the browser shows for the new passkey in its passkey
          // manager.
          userName: username,
          userDisplayName: username,
          excludeCredentials,
        }),
      };
    },
  });
}

export function finishAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      response: vRegistrationResponseJSON,
    },
    returns: finishAddPasskeyResult,
    handler: async (ctx, args): Promise<FinishAddPasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }
      const passkeys = await ctx.runQuery(
        config.component.registration.listPasskeys,
        { userId },
      );
      if (passkeys.length >= MAX_PASSKEYS_PER_USER) {
        return { success: false, userError: { error: "TOO_MANY_PASSKEYS" } };
      }

      const registrationResult = await ctx.runMutation(
        config.component.registration.finishRegistrationForExistingUser,
        {
          expectedRpId: config.rpId,
          expectedOrigin: config.origin,
          verifiedUserId: userId,
          response: args.response,
          // The app does not name a new passkey yet, thus the method names
          // it after the authenticator model.
          // TODO(nicolas) Allow the user to provide a custom name when creating a passkey
          name: defaultPasskeyName(args.response),
        },
      );
      if (!registrationResult.success) {
        const { userError } = registrationResult;
        if (userError.error === "INVALID_NAME") {
          // Not possible: the only name that this function passes is a
          // default name, and every default name is a short label that the
          // component stores.
          throw new Error(
            "Unexpected error when storing the passkey: INVALID_NAME",
            { cause: userError },
          );
        }
        // A `PROTOCOL_ERROR` here also covers a registration ceremony that
        // belongs to a different user than the caller, which happens when the
        // caller signs in as a different user after the `verifyAddPasskey`
        // call. `finishRegistrationForExistingUser` compares the owner of the
        // ceremony with `verifiedUserId`, thus this call needs no check of its
        // own. See the same case in `verifyAddPasskey`.
        return { success: false, userError };
      }
      return { success: true, passkeyId: registrationResult.passkeyId };
    },
  });
}
