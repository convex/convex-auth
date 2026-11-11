// Helpers related to session and token expiry.

import type { Doc } from "./_generated/dataModel.ts";
import type { MutationCtx, QueryCtx } from "./_generated/server.ts";
import type { TtlConfig } from "../lib/ttl.ts";

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

/** The lifetimes that the cleanup loops need, as stored in `ttlConfig`. */
export type StoredTtlConfig = Pick<
  TtlConfig,
  "refreshInactivityTimeoutSeconds" | "sessionMaxLifetimeSeconds"
>;

/**
 * Store the session lifetimes that a call was given, for the cleanup loops.
 *
 * Returns `true` when a stored value changed (or none was stored yet), in
 * which case the caller pings the loops: a lowered lifetime can expire
 * sessions right away. Writes nothing when the values are unchanged, which is
 * the common case, so the read is all a refresh pays.
 */
export async function recordTtlConfig(
  ctx: MutationCtx,
  ttl: TtlConfig,
): Promise<boolean> {
  const values: StoredTtlConfig = {
    refreshInactivityTimeoutSeconds: ttl.refreshInactivityTimeoutSeconds,
    sessionMaxLifetimeSeconds: ttl.sessionMaxLifetimeSeconds,
  };
  const stored = await ctx.db.query("ttlConfig").first();
  if (stored === null) {
    await ctx.db.insert("ttlConfig", values);
    return true;
  }
  if (
    stored.refreshInactivityTimeoutSeconds ===
      values.refreshInactivityTimeoutSeconds &&
    stored.sessionMaxLifetimeSeconds === values.sessionMaxLifetimeSeconds
  ) {
    return false;
  }
  await ctx.db.patch("ttlConfig", stored._id, values);
  return true;
}

/**
 * The session lifetimes that the app last passed in, or `null` when no call
 * has stored them yet.
 *
 * The cleanup loops run with no caller, thus this stored copy is all they
 * have. It lags a deploy that changes a lifetime until the next sign-in or
 * refresh stores the new value, whereas `refresh` always checks expiry against
 * the lifetimes of its own call.
 */
export async function storedTtlConfig(
  ctx: QueryCtx,
): Promise<StoredTtlConfig | null> {
  const stored = await ctx.db.query("ttlConfig").first();
  if (stored === null) return null;
  return {
    refreshInactivityTimeoutSeconds: stored.refreshInactivityTimeoutSeconds,
    sessionMaxLifetimeSeconds: stored.sessionMaxLifetimeSeconds,
  };
}
