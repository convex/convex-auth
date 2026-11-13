/**
 * Everything about Google that never varies between apps. This component
 * serves Google only, so these are constants rather than configuration.
 *
 * @module
 */

/** Where the browser is sent to sign in. */
export const AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

/** Where the authorization code is exchanged for tokens. */
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Google's public signing keys, which verify an id_token that reached the
 * app from the device instead of from Google's token endpoint.
 */
export const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * Accepted `iss` claims for Google's id_tokens. Google documents both forms,
 * with and without the https prefix, and both name the same issuer, so a
 * given account has the same `sub` either way.
 */
export const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * What the sign-in asks for. `openid` is what makes Google return the
 * id_token the profile is built from.
 */
export const SCOPES = ["openid", "email", "profile"];

/** The name this provider's accounts are namespaced under in the core. */
export const PROVIDER_NAME = "google";
