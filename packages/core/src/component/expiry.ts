// Token lifetimes: their defaults, the validated config of a call, when a
// refresh token expires under it, and the copy the component stores for the
// cleanup loop.

import type { Doc } from "./_generated/dataModel.ts";
import type { MutationCtx, QueryCtx } from "./_generated/server.ts";

// Defaults for the configurable token lifetimes. The app overrides them per
// deployment via `setupConvexAuth`, which threads the chosen values in as call
// args; when it passes nothing, these apply.
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

/**
 * Store the refresh-token TTL that a call was given, for the cleanup loop.
 *
 * Returns `true` when the stored value changed (or none was stored yet), in
 * which case the caller pings the loop: a lowered TTL can expire sessions
 * right away. Writes nothing when the value is unchanged, which is the common
 * case, so the read is all a refresh pays.
 */
export async function recordTtlConfig(
  ctx: MutationCtx,
  ttl: TtlConfig,
): Promise<boolean> {
  const stored = await ctx.db.query("ttlConfig").first();
  if (stored === null) {
    await ctx.db.insert("ttlConfig", {
      refreshTokenTtlSeconds: ttl.refreshTokenTtlSeconds,
    });
    return true;
  }
  if (stored.refreshTokenTtlSeconds === ttl.refreshTokenTtlSeconds) {
    return false;
  }
  await ctx.db.patch("ttlConfig", stored._id, {
    refreshTokenTtlSeconds: ttl.refreshTokenTtlSeconds,
  });
  return true;
}

/**
 * The refresh-token TTL that the app last passed in, or `null` when no call
 * has stored one yet.
 *
 * The cleanup loop runs with no caller, thus this stored copy is all it has.
 * It lags a deploy that changes the TTL until the next sign-in or refresh
 * stores the new value, whereas `refresh` always checks expiry against the
 * TTL of its own call.
 */
export async function storedRefreshTokenTtlSeconds(
  ctx: QueryCtx,
): Promise<number | null> {
  const stored = await ctx.db.query("ttlConfig").first();
  return stored?.refreshTokenTtlSeconds ?? null;
}
