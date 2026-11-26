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
    passkeys: ["name", "transports"],
    // totp
    totpSecrets: ["status"],
    // OAuth providers
    accounts: ["providerName", "providerAccountId"],
    authorizationRequests: [
      "providerName",
      "redirectTo",
      "callbackUrl",
      "tokenEndpoint",
      "userInfoEndpoints",
      "issuers",
    ],
    tickets: ["providerName"],
    // the rate limiter of the password component
    rateLimits: ["name"],
  },
  personalFields: {
    usernames: ["username", "usernameNormalized"],
    verifiedEmails: ["email", "normalizedEmail"],
    challenges: ["email"],
    // A rate limit key can be a user id, a username, or an email address.
    rateLimits: ["key"],
  },
  keepPersonalData: true,
};
