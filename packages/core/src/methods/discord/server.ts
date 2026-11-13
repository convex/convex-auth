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
  /** The unique username. Users can change it, so don't key anything on it. */
  username: v.string(),
  /** The display name, falling back to the username. */
  name: v.string(),
  email: v.optional(v.string()),
  /**
   * Discord's `verified` flag for the email. False when Discord reports the
   * email as unverified, so don't trust it for account linking then.
   */
  emailVerified: v.boolean(),
  /** The custom avatar, or Discord's default avatar when there is none. */
  avatarUrl: v.string(),
});

export type DiscordProfile = Infer<typeof vDiscordProfile>;

const CDN = "https://cdn.discordapp.com";

/**
 * The avatar URL, following
 * https://discord.com/developers/docs/reference#image-formatting. A user
 * without a custom avatar gets one of Discord's default avatars: chosen from
 * the id on the new username system (discriminator `"0"`), and from the
 * legacy discriminator otherwise.
 */
function avatarUrl(user: {
  id: string;
  avatar?: string | null;
  discriminator?: string;
}): string {
  if (typeof user.avatar === "string" && user.avatar !== "") {
    const format = user.avatar.startsWith("a_") ? "gif" : "png";
    return `${CDN}/avatars/${user.id}/${user.avatar}.${format}`;
  }
  const discriminator = Number(user.discriminator ?? "0");
  const index =
    discriminator === 0 || Number.isNaN(discriminator)
      ? Number((BigInt(user.id) >> 22n) % 6n)
      : discriminator % 5;
  return `${CDN}/embed/avatars/${index}.png`;
}

/** Map Discord's userinfo response to {@link DiscordProfile}. */
export function normalizeDiscordProfile(
  userInfoResponses: DiscordUserInfo | undefined,
): DiscordProfile {
  const user = userInfoResponses?.user;
  if (user === undefined) {
    throw new Error("Discord userinfo response is missing the `user` entry");
  }
  // The response is untrusted JSON. A missing id would collapse every
  // affected user into one account, so it is checked here rather than left
  // to the profile validator. Discord ids are snowflakes, sent as decimal
  // strings. A missing `username` needs no such check: it fails the profile
  // validator instead of corrupting anything.
  if (typeof user.id !== "string" || !/^\d+$/.test(user.id)) {
    throw new Error("Discord userinfo `user` entry is missing an id");
  }
  const email =
    typeof user.email === "string" && user.email !== ""
      ? user.email
      : undefined;
  return {
    id: user.id,
    username: user.username,
    name: user.global_name ?? user.username,
    email,
    emailVerified: email !== undefined && user.verified === true,
    avatarUrl: avatarUrl(user),
  };
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
 * 2. Register `<site-url>/oauth/discord/callback` as the redirect URI with
 *    Discord.
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
