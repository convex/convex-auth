// When refresh tokens and sessions expire under the configured lifetimes.

import type { Doc } from "./_generated/dataModel.ts";

/**
 * Returns a timestamp for when a refresh token stops being able to refresh its
 * session for lack of use, under the given inactivity timeout.
 *
 * Expiry is derived rather than stored, so a changed timeout applies to every
 * outstanding token.
 */
export function refreshTokenInactivityExpiresAt(
  token: Pick<Doc<"refreshTokens">, "_creationTime">,
  refreshInactivityTimeoutSeconds: number,
): number {
  return token._creationTime + refreshInactivityTimeoutSeconds * 1000;
}

/**
 * Returns a timestamp for when a session reaches its max lifetime.
 *
 * Derived from the session's `_creationTime`, so a changed max lifetime
 * applies to every session.
 */
export function sessionMaxLifetimeExpiresAt(
  session: Pick<Doc<"sessions">, "_creationTime">,
  sessionMaxLifetimeSeconds: number,
): number {
  return session._creationTime + sessionMaxLifetimeSeconds * 1000;
}
