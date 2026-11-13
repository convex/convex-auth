/**
 * The `google` sign-in method, exported at
 * `@convex-dev/auth/methods/google/server`.
 *
 * @module
 */
import { actionGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import type { UserCallbacks } from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import { buildStartSignIn } from "../../lib/oauth/authorize.ts";
import {
  buildCompleteSignIn,
  validateAllowedRedirectOrigins,
  type OidcClaims,
} from "../../lib/oauth/redemption.ts";
import type { ComponentApi } from "../../components/google/_generated/component.ts";
import {
  AUTHORIZATION_ENDPOINT,
  PROVIDER_NAME,
  SCOPES,
} from "../../components/google/constants.ts";

/** The name of this sign-in method. The app's user callbacks get it as `method.name`. */
const METHOD_NAME = "google";

/**
 * The account profile that the `google` method produces. Google is OIDC, so
 * identity comes from validated id_token claims. This is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const vGoogleProfile = v.object({
  /** Google's `sub` claim, the stable provider account id. */
  id: v.string(),
  email: v.optional(v.string()),
  /**
   * True when Google attested the email as verified (the `email_verified`
   * claim). False means unverified or the claim was absent, so don't trust
   * the email for account linking.
   */
  emailVerified: v.boolean(),
  name: v.optional(v.string()),
  picture: v.optional(v.string()),
});

export type GoogleProfile = Infer<typeof vGoogleProfile>;

/**
 * Map validated Google id_token claims to {@link GoogleProfile}. Google
 * returns an id_token, so `claims` is always present here. A missing one is
 * a bug.
 */
export function normalizeGoogleProfile(
  claims: OidcClaims | undefined,
): GoogleProfile {
  if (claims === undefined) {
    throw new Error("Google returned no id_token to build a profile from");
  }
  return {
    id: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: claims.name,
    picture: claims.picture,
  };
}

/**
 * Check the client ids at setup, so a mistake fails at deploy time. A Google
 * OAuth client id ends in `.apps.googleusercontent.com`.
 */
function validateNativeAppClientIds(clientIds: string[]): string[] {
  for (const clientId of clientIds) {
    if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      throw new Error(
        `nativeAppClientIds entry is not a Google OAuth client id: "${clientId}" ` +
          `(expected e.g. "1234-abc.apps.googleusercontent.com")`,
      );
    }
  }
  return clientIds;
}

/** App-defined config for setting up the `google` method. */
export type GoogleOptions = {
  /** The Google oauth component instance, i.e. `components.authGoogle`. */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
  /**
   * OAuth client ids that the native apps request id_tokens for, e.g.
   * `["1234-ios.apps.googleusercontent.com"]`. The Google Sign-In SDK on iOS
   * addresses its token to the iOS client id. Android's Credential Manager
   * addresses it to the `serverClientId` it is given, usually the web client
   * id. `exchangeGoogleIdToken` accepts a token only for one of these.
   */
  nativeAppClientIds?: string[];
  /**
   * Accept a native id_token without a nonce. Some Google sign-in libraries
   * cannot put a nonce in the request. Without one, a token that leaks can
   * be exchanged by anyone until it expires (about an hour), so leave this
   * off when your library can set a nonce. Defaults to `false`.
   */
  allowIdTokensWithoutNonce?: boolean;
};

/**
 * Built-in sign-in method for Google. Wire it up with the Google oauth component:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(auth, {
 *   component: components.authGoogle,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserGoogle });
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/google"`, binding Google's `CLIENT_ID` and
 *    `CLIENT_SECRET`.
 * 2. Register `<site-url>/oauth/google/callback` as the redirect URI with
 *    Google.
 *
 * The `httpPrefix` alone determines the callback URL.
 *
 * A native iOS or Android app signs in with Google's own SDK instead. Set
 * `nativeAppClientIds`, export `exchangeGoogleIdToken` too, and redeem what
 * it returns with `completeSignInWithGoogle`.
 */
export function setupGoogle<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: GoogleOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time, not on the first sign-in.
  const allowedOrigins = validateAllowedRedirectOrigins(
    options.allowedRedirectOrigins,
  );
  const nativeAppClientIds = validateNativeAppClientIds(
    options.nativeAppClientIds ?? [],
  );
  const allowIdTokensWithoutNonce = options.allowIdTokensWithoutNonce ?? false;

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get the functions of this method to export.
     */
    attachUserCallbacks(
      callbacks: UserCallbacks<typeof METHOD_NAME, GoogleProfile, UsersTable>,
    ) {
      const { authMutation } = core.bindMethod({
        name: METHOD_NAME,
        createUser: callbacks.createUser,
        onSignIn: callbacks.onSignIn,
      });

      const startSignIn = buildStartSignIn({
        providerName: PROVIDER_NAME,
        allowedOrigins,
        authorizationEndpoint: AUTHORIZATION_ENDPOINT,
        scopes: SCOPES,
        createAuthorizationRequest:
          options.component.provider
            ._internal_dangerous_createAuthorizationRequest,
      });

      const completeSignIn = buildCompleteSignIn<
        GoogleProfile,
        { claims?: OidcClaims }
      >({
        providerName: PROVIDER_NAME,
        authMutation,
        component: options.component,
        claimTicket: (ctx, args) =>
          ctx.runMutation(options.component.provider.claimTicket, args),
        getUserIdByAccount: (ctx, args) =>
          ctx.runQuery(options.component.provider.getUserIdByAccount, args),
        createAccount: (ctx, args) =>
          ctx.runMutation(
            options.component.provider._internal_dangerous_createAccount,
            args,
          ),
        profile: (payload) => normalizeGoogleProfile(payload.claims),
      });

      /**
       * Exchange the id_token of a native sign-in for the `code` and `state`
       * that `completeSignIn` redeems. `nonce` is the raw nonce whose hex
       * SHA-256 the app put in the sign-in request.
       */
      const exchangeIdToken = actionGeneric({
        args: { idToken: v.string(), nonce: v.optional(v.string()) },
        handler: async (ctx, args) => {
          if (nativeAppClientIds.length === 0) {
            throw new Error(
              "Set `nativeAppClientIds` in the options of `setupGoogle` to " +
                "accept id_tokens from native apps",
            );
          }
          if (args.nonce === undefined && !allowIdTokensWithoutNonce) {
            throw new Error(
              "Send the nonce of the sign-in request, or set " +
                "`allowIdTokensWithoutNonce` in the options of `setupGoogle`",
            );
          }
          return await ctx.runAction(
            options.component.native._internal_dangerous_exchangeIdToken,
            { ...args, audiences: nativeAppClientIds },
          );
        },
      });

      return {
        startSignInWithGoogle: startSignIn,
        completeSignInWithGoogle: completeSignIn,
        exchangeGoogleIdToken: exchangeIdToken,
      };
    },
  };
}
