/**
 * The project config for Convex Auth (`@convex-dev/auth`): the string fields of
 * the tables of its components that the timeline keeps.
 *
 * Each name is safe in every table of that name, whatever the component: an
 * app mounts the components under names of its own choice.
 *
 * @module
 */
import type { ProjectConfig } from "../project.ts";

export const convexAuthProject: ProjectConfig = {
  name: "convex-auth",
  safeFields: {
    // core
    sessions: ["component"],
    refreshTokens: ["state"],
    // email
    challenges: ["purpose", "kind"],
    // passkey
    passkeys: ["transports"],
    // totp
    totpSecrets: ["status"],
    // OAuth providers
    accounts: ["providerName"],
    authorizationRequests: [
      "providerName",
      // Built from the deployment's site URL and a fixed path: no input of a
      // person.
      "callbackUrl",
      "tokenEndpoint",
      "userInfoEndpoints",
      "issuers",
    ],
    tickets: ["providerName"],
    // the rate limiter of the password component
    rateLimits: ["name"],
  },
  urlFields: {
    // The page of the app to return to after the provider, which the client
    // names. Its query and fragment can hold anything the app put there.
    authorizationRequests: ["redirectTo"],
  },
  personalFields: {
    // Who the person is at the OAuth provider.
    accounts: ["providerAccountId"],
    // The name a person gave their passkey.
    passkeys: ["name"],
    usernames: ["username", "usernameNormalized"],
    verifiedEmails: ["email", "normalizedEmail"],
    challenges: ["email"],
    // A rate limit key can be a user id, a username, or an email address.
    rateLimits: ["key"],
  },
  keepPersonalData: true,
  browser: {
    // `__convexAuthJWT_<namespace>`, `__convexAuthRefreshToken_<namespace>`,
    // and the keys of the ambient sign-ins, `__convexAuthProvider_<id>_...`
    // (see `packages/core/src/browser/storage.ts`).
    secretStorageKeys: ["__convexAuth"],
    // The outcome of a method (`{ status: "complete" }`), a refresh
    // (`{ kind: "rotated" }`), and a user error (`{ error: "..." }`).
    safeKeys: ["status", "kind", "error"],
    personalKeys: ["username", "email"],
    // `sub` is the session id, `aud` "convex-auth", `iss` the deployment's
    // URL. `jti` is left out: it is unique to the token and tells nothing.
    safeJwtClaims: ["sub", "aud", "iss"],
    // The core stores `sha256Hex(refreshToken)` in `refreshTokens.hash`
    // (`packages/core/src/component/sessions.ts`).
    secretDigests: [
      { table: "refreshTokens", field: "hash", digest: "sha256Hex" },
    ],
    // The subject of an access token is its session.
    claimLinks: [{ claim: "sub", table: "sessions" }],
  },
};
