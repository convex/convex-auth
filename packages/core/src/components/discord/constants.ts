/**
 * Everything about Discord that never varies between apps. That is the
 * endpoints, the scopes, the authorization parameters, and the shape its
 * userinfo endpoint returns.
 *
 * This component serves Discord only, so these are constants rather than
 * configuration. The response types live here because the endpoint map is
 * keyed by them.
 *
 * @module
 */
/** Where the browser is sent to sign in. */
export const AUTHORIZATION_ENDPOINT = "https://discord.com/oauth2/authorize";

/** Where the authorization code is exchanged for tokens. */
export const TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";

/** Skips the consent screen for a user who already authorized the app. */
export const AUTHORIZATION_PARAMS = { prompt: "none" };

/** The Discord `/users/@me` fields the mapping reads. */
type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
  email?: string | null;
  verified?: boolean;
};

/**
 * The responses the component's userinfo endpoints produce, keyed the way
 * {@link USER_INFO_ENDPOINTS} names them. This is what Discord is trusted to
 * return; the responses are not validated against it at runtime.
 */
export type DiscordUserInfo = { user: DiscordUser };

/**
 * What the callback fetches with the access token, keyed by the name the
 * profile mapping reads each response under. Discord is plain OAuth and
 * returns no id_token, so this is where identity comes from. The API version
 * is pinned, because the unversioned path serves a deprecated default
 * version.
 */
export const USER_INFO_ENDPOINTS: Record<keyof DiscordUserInfo, string> = {
  user: "https://discord.com/api/v10/users/@me",
};

/** What the sign-in asks for. `email` adds the email and its `verified` flag. */
export const SCOPES = ["identify", "email"];

/** The name this provider's accounts are namespaced under in the core. */
export const PROVIDER_NAME = "discord";
