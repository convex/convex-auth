/**
 * The flow that re-authenticates a signed-in user with one of their passkeys,
 * before a sensitive action. Both passkey methods use it.
 *
 * The verified assertion counts as a new authentication of the current
 * session: `getAuthenticationTime` reports it, and
 * `requireRecentAuthentication` accepts it. The other sessions of the user
 * are not affected.
 *
 * ```
 *  Client                                       Method
 *    │                                             │
 *    │  startPasskeyReauthentication()             │
 *    ├────────────────────────────────────────────▶│  start the authentication
 *    │◀────────────────────────────────────────────┤  (the user's passkeys)
 *    │                                             │
 *    ├─▶ navigator.credentials.get()               │
 *    │                                             │
 *    │  finishPasskeyReauthentication(assertion)   │
 *    ├────────────────────────────────────────────▶│  verify it, record it on
 *    │◀────────────────────────────────────────────┤  the current session
 *    │                                             │
 * ```
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../../server/userId.ts";
import type { AuthMutationBuilder } from "../../../server/setup.ts";
import type { SignInAuthHelpers } from "../../../lib/types.ts";
import type { ComponentApi } from "../../../components/passkey/_generated/component.ts";
import type { ComponentApi as CoreComponentApi } from "../../../component/_generated/component.ts";
import {
  finishAuthenticationUserError,
  notLoggedInUserError,
  vAuthenticationResponseJSON,
  vPublicKeyCredentialRequestOptionsJSON,
  type ExpectedOrigin,
} from "../../../components/passkey/validation.ts";
import { buildAuthenticationOptions } from "../options.ts";

/**
 * What the re-authentication functions of a passkey method close over.
 *
 * @internal
 */
export type PasskeyReauthenticationConfig = {
  component: ComponentApi;
  coreComponent: CoreComponentApi;
  rpId: string;
  origin: ExpectedOrigin;
  /** The purpose of the challenge, a constant of the method. */
  purpose: string;
};

/** The user-facing error when the signed-in user has no passkey. */
const noPasskeyUserError = v.object({ error: v.literal("NO_PASSKEY") });

const startPasskeyReauthenticationResult = v.union(
  v.object({
    success: v.literal(true),
    // Ready for the `navigator.credentials.get()` call. The
    // `allowCredentials` list holds the passkeys of the user.
    options: vPublicKeyCredentialRequestOptionsJSON,
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(notLoggedInUserError, noPasskeyUserError),
  }),
);

export type StartPasskeyReauthenticationResult = Infer<
  typeof startPasskeyReauthenticationResult
>;

const finishPasskeyReauthenticationResult = v.union(
  v.object({
    success: v.literal(true),
    /** When the re-authentication counts from, in milliseconds since the epoch. */
    authenticatedAt: v.number(),
  }),
  v.object({
    success: v.literal(false),
    // `PROTOCOL_ERROR` also covers an assertion that authenticates a
    // different user than the caller.
    userError: v.union(notLoggedInUserError, finishAuthenticationUserError),
  }),
);

export type FinishPasskeyReauthenticationResult = Infer<
  typeof finishPasskeyReauthenticationResult
>;

/**
 * Make the `startPasskeyReauthentication` mutation of a passkey method.
 *
 * @internal
 */
export function startPasskeyReauthentication(
  config: PasskeyReauthenticationConfig,
) {
  return mutationGeneric({
    args: {},
    returns: startPasskeyReauthenticationResult,
    handler: async (ctx): Promise<StartPasskeyReauthenticationResult> => {
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_LOGGED_IN" } };
      }
      const passkeys = await ctx.runQuery(
        config.component.registration.listPasskeys,
        { userId },
      );
      if (passkeys.length === 0) {
        // Checked before the challenge is made, so that no challenge is left
        // behind.
        return { success: false, userError: { error: "NO_PASSKEY" } };
      }
      // The challenge is bound to the user, so only a passkey of the user
      // can answer it.
      const { challenge, allowCredentials } = await ctx.runMutation(
        config.component.authentication.startAuthentication,
        { purpose: config.purpose, userId },
      );
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

/**
 * Make the `finishPasskeyReauthentication` mutation of a passkey method.
 *
 * @internal
 */
export function finishPasskeyReauthentication<Profile>(
  config: PasskeyReauthenticationConfig,
  authMutation: AuthMutationBuilder<Profile, SignInAuthHelpers<Profile>>,
) {
  return authMutation({
    args: {
      response: vAuthenticationResponseJSON,
    },
    returns: finishPasskeyReauthenticationResult,
    handler: async (
      ctx,
      args,
    ): Promise<FinishPasskeyReauthenticationResult> => {
      const userId = await getAuthUserId(ctx, config.coreComponent);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_LOGGED_IN" } };
      }

      // Consumes the challenge whatever the outcome, so an assertion is
      // never redeemed twice.
      const authenticationResult = await ctx.runMutation(
        config.component.authentication.finishAuthentication,
        {
          purpose: config.purpose,
          expectedRpId: config.rpId,
          expectedOrigin: config.origin,
          response: args.response,
        },
      );
      if (!authenticationResult.success) {
        return { success: false, userError: authenticationResult.userError };
      }
      if (authenticationResult.userId !== userId) {
        // The challenge is bound to the user who started the ceremony, and
        // that user is no longer the caller: the caller signed in as a
        // different user after `startPasskeyReauthentication`.
        console.warn(
          "Rejected a passkey re-authentication because the assertion " +
            "authenticates a different user than the caller. The caller " +
            "signed in as a different user after the " +
            "`startPasskeyReauthentication` call.",
        );
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
      }

      // Recorded on the session of this request, which the core checks
      // belongs to `userId`.
      const { authenticatedAt } = await ctx.convexAuth.recordReauthentication({
        userId,
        authenticatedBy: config.component,
      });
      return { success: true, authenticatedAt };
    },
  });
}
