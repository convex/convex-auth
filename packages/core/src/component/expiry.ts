// Token lifetimes: the validated config of a call, and when a refresh token
// expires under it.

import type { Doc } from "./_generated/dataModel.ts";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
} from "../lib/ttl.ts";

/**
 * The token lifetimes for a call, with the app's overrides applied over the
 * defaults. Validated so a misconfiguration fails loudly rather than minting
 * nonsensical sessions.
 */
export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}): TtlConfig {
  const accessTokenTtlSeconds =
    args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTokenTtlSeconds =
    args.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  if (accessTokenTtlSeconds <= 0 || refreshTokenTtlSeconds <= 0) {
    throw new Error("Token TTLs must be positive.");
  }
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh-token TTL.",
    );
  }
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}

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
