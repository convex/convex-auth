/**
 * Everything about Discord that never varies between apps. That is the
 * endpoints, the scopes, and the shape its userinfo endpoint returns.
 *
 * This component serves Discord only, so these are constants rather than
 * configuration. The response type lives here because the endpoint map is
 * keyed by it.
 *
 * @module
 */
/** Where the browser is sent to sign in. */
export const AUTHORIZATION_ENDPOINT = "https://discord.com/oauth2/authorize";

/** Where the authorization code is exchanged for tokens. */
export const TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";

/**
 * The Discord `/users/@me` fields the mapping reads. See
 * https://discord.com/developers/docs/resources/user#user-object.
 */
type DiscordUser = {
  /** A snowflake, sent as a string. */
  id: string;
  username: string;
  /** The display name, if the user set one. */
  global_name?: string | null;
  /** `"0"` for users on the new username system. */
  discriminator?: string;
  /** The avatar hash, or null when the user has the default avatar. */
  avatar?: string | null;
  /** Present only with the `email` scope, and null when there is none. */
  email?: string | null;
  /** Whether the email has been verified. Present only with the `email` scope. */
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
 * returns no id_token, so this is where identity comes from.
 */
export const USER_INFO_ENDPOINTS: Record<keyof DiscordUserInfo, string> = {
  user: "https://discord.com/api/users/@me",
};

/** What the sign-in asks for. */
export const SCOPES = ["identify", "email"];

/** The name this provider's accounts are namespaced under in the core. */
export const PROVIDER_NAME = "discord";
