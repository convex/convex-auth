/**
 * The `discord` sign-in method, exported at
 * `@convex-dev/auth/methods/discord/server`.
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
import type { ComponentApi } from "../../components/discord/_generated/component.ts";
import {
  AUTHORIZATION_ENDPOINT,
  AUTHORIZATION_PARAMS,
  PROVIDER_NAME,
  SCOPES,
  type DiscordUserInfo,
} from "../../components/discord/constants.ts";

/** The name of this sign-in method. The app's user callbacks get it as `method.name`. */
const METHOD_NAME = "discord";

export type { DiscordUserInfo };

/**
 * The account profile that the `discord` method produces. Discord is plain
 * OAuth (no id_token), so identity comes from its userinfo endpoint. This is
 * the exact shape the mapping emits, so the app can validate against it
 * precisely.
 */
export const vDiscordProfile = v.object({
  /** Discord's user id (a snowflake), the stable provider account id. */
  id: v.string(),
  /** The Discord username. Not an identifier: only `id` is stable and unique. */
  username: v.string(),
  /** The display name: `global_name`, or the username when it is unset. */
  name: v.string(),
  email: v.optional(v.string()),
  /**
   * True only when Discord reports the email as verified. False when there
   * is no email or Discord has not verified it, so don't trust it for account
   * linking.
   */
  emailVerified: v.boolean(),
  /** The user's avatar, or Discord's default avatar for the account. */
  avatarUrl: v.string(),
});

export type DiscordProfile = Infer<typeof vDiscordProfile>;

/** Where Discord serves avatars from. */
const CDN_URL = "https://cdn.discordapp.com";

/** Map Discord's userinfo response to {@link DiscordProfile}. */
export function normalizeDiscordProfile(
  userInfoResponses: DiscordUserInfo | undefined,
): DiscordProfile {
  const user = userInfoResponses?.user;
  if (user === undefined) {
    throw new Error("Discord userinfo response is missing the `user` entry");
  }
  // The response is untrusted JSON. A missing id must not become a shared
  // account id, and the default avatar parses the id as a BigInt, so the id
  // has to be a string of decimal digits. A missing `username` needs no such
  // check: it fails the profile validator instead of corrupting anything.
  if (typeof user.id !== "string" || !/^[0-9]+$/.test(user.id)) {
    throw new Error("Discord userinfo `user` entry is missing a valid id");
  }
  const email = user.email ?? undefined;
  return {
    id: user.id,
    username: user.username,
    // `||` rather than `??`, so an empty `global_name` falls back too.
    name: user.global_name || user.username,
    email,
    emailVerified: email !== undefined && user.verified === true,
    avatarUrl: avatarUrl(user),
  };
}

/**
 * The URL of the user's avatar. A user with no avatar of their own gets one of
 * Discord's default avatars, picked the way Discord picks it.
 */
function avatarUrl(user: DiscordUserInfo["user"]): string {
  // The hash goes into a URL path, so only a well-formed one is used.
  if (typeof user.avatar === "string" && /^(a_)?[0-9a-f]+$/.test(user.avatar)) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `${CDN_URL}/avatars/${user.id}/${user.avatar}.${extension}`;
  }
  // A user on the new username system has the discriminator "0".
  const legacyDiscriminator =
    typeof user.discriminator === "string" &&
    /^[0-9]+$/.test(user.discriminator) &&
    user.discriminator !== "0"
      ? user.discriminator
      : undefined;
  const index =
    legacyDiscriminator === undefined
      ? Number((BigInt(user.id) >> 22n) % 6n)
      : Number(legacyDiscriminator) % 5;
  return `${CDN_URL}/embed/avatars/${index}.png`;
}

/** App-defined config for setting up the `discord` method. */
export type DiscordOptions = {
  /** The Discord oauth component instance, i.e. `components.authDiscord`. */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/**
 * Built-in sign-in method for Discord. Wire it up with the Discord oauth component:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { startSignInWithDiscord, completeSignInWithDiscord } = setupDiscord(auth, {
 *   component: components.authDiscord,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserDiscord });
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/discord"`, binding Discord's `CLIENT_ID` and
 *    `CLIENT_SECRET`.
 * 2. Register `<site-url>/oauth/discord/callback` as a redirect URI of the
 *    application in the Discord Developer Portal.
 *
 * The `httpPrefix` alone determines the callback URL.
 */
export function setupDiscord<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: DiscordOptions,
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
      callbacks: UserCallbacks<typeof METHOD_NAME, DiscordProfile, UsersTable>,
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
        extraAuthorizationParams: AUTHORIZATION_PARAMS,
        createAuthorizationRequest:
          options.component.provider
            ._internal_dangerous_createAuthorizationRequest,
      });

      const completeSignIn = buildCompleteSignIn<
        DiscordProfile,
        { userInfoResponses?: DiscordUserInfo }
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
        profile: (payload) =>
          normalizeDiscordProfile(payload.userInfoResponses),
      });

      return {
        startSignInWithDiscord: startSignIn,
        completeSignInWithDiscord: completeSignIn,
      };
    },
  };
}
