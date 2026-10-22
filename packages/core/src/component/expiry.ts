// When a refresh token expires under the configured lifetimes.

import type { Doc } from "./_generated/dataModel.ts";

/**
 * When a refresh token expires under the given refresh-token TTL.
 *
 * Expiry is derived rather than stored, so a changed TTL applies to every
 * outstanding token. It also means a session's newest token is always its
 * last to expire.
 */
export function refreshTokenExpiresAt(
  token: Pick<Doc<"refreshTokens">, "_creationTime">,
  refreshTokenTtlSeconds: number,
): number {
  return token._creationTime + refreshTokenTtlSeconds * 1000;
}
