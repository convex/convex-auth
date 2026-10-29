/**
 * The `google` sign-in method, exported at
 * `@convex-dev/auth/methods/google/server`.
 *
 * @module
 */
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

/** App-defined config for setting up the `google` method. */
export type GoogleProviderOptions = {
  /** The Google oauth component instance, i.e. `components.authGoogle`. */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
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
 */
export function setupGoogle<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: GoogleProviderOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time, not on the first sign-in.
  const allowedOrigins = validateAllowedRedirectOrigins(
    options.allowedRedirectOrigins,
  );

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get the functions of this method to export.
     */
    attachUserCallbacks(
      callbacks: UserCallbacks<"google", GoogleProfile, UsersTable>,
    ) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser: callbacks.createUser,
        onSignIn: callbacks.onSignIn,
      });

      const startSignIn = buildStartSignIn({
        allowedOrigins,
        authorizationEndpoint: AUTHORIZATION_ENDPOINT,
        scopes: SCOPES,
        createAuthorizationRequest:
          options.component.provider.createAuthorizationRequest,
      });

      const completeSignIn = buildCompleteSignIn<
        GoogleProfile,
        { claims?: OidcClaims }
      >({
        providerName: PROVIDER_NAME,
        authMutation,
        claimTicket: (ctx, args) =>
          ctx.runMutation(options.component.provider.claimTicket, args),
        profile: (payload) => normalizeGoogleProfile(payload.claims),
      });

      return {
        startSignInWithGoogle: startSignIn,
        completeSignInWithGoogle: completeSignIn,
      };
    },
  };
}
