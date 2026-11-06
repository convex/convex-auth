// Helpers related to session and token expiry.

import type { Doc } from "./_generated/dataModel.ts";
import type { MutationCtx } from "./_generated/server.ts";
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

/** The lifetimes that are stored in `ttlConfig`. */
export type StoredTtlConfig = Pick<
  TtlConfig,
  "refreshInactivityTimeoutSeconds" | "sessionMaxLifetimeSeconds"
>;

/**
 * Store the session lifetime values.
 *
 * These should be the current values that the app uses when issuing new
 * sessions and tokens.
 *
 * The values are meant to be consumed by background logic that can't receive
 * them directly.
 *
 * Returns `true` when a stored value changed or was written for the first time.
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
