/**
 * The `apple` sign-in method, exported at
 * `@convex-dev/auth/methods/apple/server`.
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
import type { ComponentApi } from "../../components/apple/_generated/component.ts";
import {
  AUTHORIZATION_ENDPOINT,
  CALLBACK_METHOD,
  PROVIDER_NAME,
  SCOPES,
} from "../../components/apple/constants.ts";
import type { SanitizedAppleUser } from "../../components/apple/user.ts";

export type { SanitizedAppleUser };

/**
 * The account profile that the `apple` method produces. Apple is OIDC, so
 * identity comes from validated id_token claims, with the name (when there
 * is one) coming from the callback instead. This is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const vAppleProfile = v.object({
  /** Apple's `sub` claim, the stable provider account id. */
  id: v.string(),
  /**
   * The email Apple attested. It is a per-app relay address
   * (`...@privaterelay.appleid.com`) for anyone who chose to hide theirs.
   *
   * Optional for two reasons: Apple only sends it when the email scope was
   * granted, and a Managed Apple Account may have no address at all, since
   * schools often issue none.
   */
  email: v.optional(v.string()),
  /**
   * True when Apple attested the email as verified (the `email_verified`
   * claim). Apple returns verified addresses for personal Apple Accounts, so
   * a false comes from Sign in with Apple at Work & School or from the claim
   * being absent.
   */
  emailVerified: v.boolean(),
  /**
   * The name the person gave at sign-up, if they gave one. Apple sends it
   * exactly once, on the first authorization, and never again, so a return
   * visit produces a profile without it. It is also the one part of the
   * profile the browser relayed rather than Apple attesting to it, which
   * makes it user-controlled display data: escape it like any other text a
   * user typed, and don't key anything off it.
   */
  name: v.optional(v.string()),
});

export type AppleProfile = Infer<typeof vAppleProfile>;

/**
 * Map Apple's validated id_token claims, plus the sanitized name from a
 * first authorization, to {@link AppleProfile}.
 *
 * `user` is undefined on every sign-in after the first, which is why the
 * profile's `name` is optional. An app that wants to keep the name should
 * store it when it arrives and leave the stored one alone when it doesn't.
 */
export function normalizeAppleProfile(
  claims: OidcClaims,
  user: SanitizedAppleUser | undefined,
): AppleProfile {
  const parts = [user?.name.firstName, user?.name.lastName].filter(
    (part) => part !== undefined,
  );
  return {
    id: claims.sub,
    email: claims.email,
    // Apple sends the string "true"/"false" for some accounts and a boolean
    // for others.
    emailVerified:
      claims.email_verified === true || claims.email_verified === "true",
    name: parts.length === 0 ? undefined : parts.join(" "),
  };
}

/** App-defined config for setting up the `apple` method. */
export type AppleProviderOptions = {
  /** The Apple oauth component instance, i.e. `components.authApple`. */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/**
 * Built-in sign-in method for Apple ("Sign in with Apple"). Wire it up with the
 * Apple oauth component:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { startSignInWithApple, completeSignInWithApple } = setupApple(auth, {
 *   component: components.authApple,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserApple });
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/apple"`, binding the Services ID, team id, key id,
 *    and `.p8` private key.
 * 2. Register `<site-url>/oauth/apple/callback` as a return URL on the
 *    Services ID, along with the `convex.site` domain it is on.
 *
 * The `httpPrefix` alone determines the callback URL, on the deployment's
 * `convex.site` host. Apple has to accept that host as a return URL and
 * rejects `localhost` and IP addresses, so the deployment has to be publicly
 * reachable. The app the flow returns to is unaffected and can stay on
 * localhost.
 */
export function setupApple<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: AppleProviderOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time.
  const allowedOrigins = validateAllowedRedirectOrigins(
    options.allowedRedirectOrigins,
  );

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get the functions of this method to export.
     */
    attachUserCallbacks(
      callbacks: UserCallbacks<"apple", AppleProfile, UsersTable>,
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
        callbackMethod: CALLBACK_METHOD,
        createAuthorizationRequest:
          options.component.provider.createAuthorizationRequest,
      });

      /**
       * Complete an Apple sign-in by redeeming the one-time `code` from the
       * callback redirect together with the state held since `startSignIn`.
       */
      const completeSignIn = buildCompleteSignIn<
        AppleProfile,
        { claims?: OidcClaims; callbackParams?: { user?: SanitizedAppleUser } }
      >({
        providerName: PROVIDER_NAME,
        authMutation,
        claimTicket: (ctx, args) =>
          ctx.runMutation(options.component.provider.claimTicket, args),
        profile: (payload) => {
          if (payload.claims === undefined) {
            throw new Error(
              "Apple returned no id_token to build a profile from",
            );
          }
          return normalizeAppleProfile(
            payload.claims,
            payload.callbackParams?.user,
          );
        },
      });

      return {
        startSignInWithApple: startSignIn,
        completeSignInWithApple: completeSignIn,
      };
    },
  };
}
