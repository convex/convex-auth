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
import {
  finishPasskeyRegistration,
  hasTooManyPasskeys,
  startPasskeyRegistration,
  tooManyPasskeysUserError,
} from "../../../lib/passkey/registration.ts";
import type { UsernamePasskeyConfig } from "../server.ts";
import {
  finishAuthenticationUserError,
  finishRegistrationUserError,
  notLoggedInUserError,
  vAuthenticationResponseJSON,
  vPublicKeyCredentialCreationOptionsJSON,
  vPublicKeyCredentialRequestOptionsJSON,
  vRegistrationResponseJSON,
} from "../../../components/passkey/validation.ts";
import { buildAuthenticationOptions } from "../../../lib/passkey/options.ts";

const startAddPasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    // Ready for the re-authentication `navigator.credentials.get()` call.
    options: vPublicKeyCredentialRequestOptionsJSON,
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(notLoggedInUserError, tooManyPasskeysUserError),
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
    userError: v.union(notLoggedInUserError, finishAuthenticationUserError),
  }),
);

export type VerifyAddPasskeyResult = Infer<typeof verifyAddPasskeyResult>;

const finishAddPasskeyResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notLoggedInUserError,
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
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_LOGGED_IN" } };
      }
      if (await hasTooManyPasskeys(ctx, config, userId)) {
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
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_LOGGED_IN" } };
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

      const username = await ctx.runQuery(
        config.usernameComponent.public.getUsername,
        { userId },
      );
      if (username === null) {
        // WebAuthn requires `user.name` and `user.displayName`, and the
        // browser keeps them in its passkey manager for the life of the
        // passkey. Only the app can remove a username, so this is an app
        // state the flow cannot serve, not a user error.
        throw new Error(
          "The signed-in user has no username. Give them a username before they add a passkey.",
        );
      }
      return {
        success: true,
        options: await startPasskeyRegistration(ctx, config, userId, {
          name: username,
          displayName: username,
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
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_LOGGED_IN" } };
      }
      return await finishPasskeyRegistration(
        ctx,
        config,
        userId,
        args.response,
      );
    },
  });
}
