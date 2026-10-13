/**
 * The `github` sign-in method, exported at
 * `@convex-dev/auth/methods/github/server`.
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
} from "../../lib/oauth/redemption.ts";
import type { ComponentApi } from "../../components/github/_generated/component.ts";
import {
  AUTHORIZATION_ENDPOINT,
  PROVIDER_NAME,
  SCOPES,
  type GithubUserInfo,
} from "../../components/github/constants.ts";

export type { GithubUserInfo };

/**
 * The account profile that the `github` method produces. GitHub is plain OAuth
 * (no id_token), so identity comes from its userinfo endpoints. This is the
 * exact shape the mapping emits, so the app can validate against it
 * precisely.
 */
export const vGithubProfile = v.object({
  /** GitHub's numeric user id as a string, the stable provider account id. */
  id: v.string(),
  login: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  /**
   * True when the email came from a verified `/user/emails` entry. False
   * means it fell back to the `/user` public profile email, whose
   * verification status is unknown, so don't trust it for account linking.
   */
  emailVerified: v.boolean(),
  avatarUrl: v.optional(v.string()),
});

export type GithubProfile = Infer<typeof vGithubProfile>;

/** Map GitHub's userinfo responses to {@link GithubProfile}. */
export function normalizeGithubProfile(
  userInfoResponses: GithubUserInfo | undefined,
): GithubProfile {
  const user = userInfoResponses?.user;
  if (user === undefined) {
    throw new Error("GitHub userinfo response is missing the `user` entry");
  }
  // The response is untrusted JSON, and String() would turn a missing id
  // into the literal string "undefined", collapsing every affected user
  // into one account. A missing `login` needs no such check: it fails the
  // profile validator instead of corrupting anything.
  if (typeof user.id !== "number" && typeof user.id !== "string") {
    throw new Error("GitHub userinfo `user` entry is missing an id");
  }
  const emails = userInfoResponses?.emails ?? [];
  const verifiedEmail =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified);
  return {
    id: String(user.id),
    login: user.login,
    name: user.name ?? user.login,
    email: verifiedEmail?.email ?? user.email ?? undefined,
    emailVerified: verifiedEmail !== undefined,
    avatarUrl: user.avatar_url,
  };
}

/** App-defined config for setting up the `github` method. */
export type GithubProviderOptions = {
  /** The GitHub oauth component instance, i.e. `components.authGithub`. */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/**
 * Built-in sign-in method for GitHub. Wire it up with the GitHub oauth component:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(auth, {
 *   component: components.authGithub,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserGithub });
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/github"`, binding GitHub's `CLIENT_ID` and
 *    `CLIENT_SECRET`.
 * 2. Register `<site-url>/oauth/github/callback` as the redirect URI with
 *    GitHub.
 *
 * The `httpPrefix` alone determines the callback URL.
 */
export function setupGithub<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: GithubProviderOptions,
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
      callbacks: UserCallbacks<"github", GithubProfile, UsersTable>,
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
        GithubProfile,
        { userInfoResponses?: GithubUserInfo }
      >({
        providerName: PROVIDER_NAME,
        authMutation,
        claimTicket: (ctx, args) =>
          ctx.runMutation(options.component.provider.claimTicket, args),
        profile: (payload) => normalizeGithubProfile(payload.userInfoResponses),
      });

      return {
        startSignInWithGithub: startSignIn,
        completeSignInWithGithub: completeSignIn,
      };
    },
  };
}
