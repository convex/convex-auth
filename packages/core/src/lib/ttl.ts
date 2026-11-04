import { v } from "convex/values";

// Defaults for the configurable lifetimes. The app overrides them per
// deployment via `setupConvexAuth`, which resolves the full configuration once
// and passes it to the core component on every call.
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
export const DEFAULT_SESSION_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days

// `ctx.auth.signJwt` refuses to mint a token that lives longer than an hour,
// so an access-token TTL past that is a misconfiguration.
const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * The configuration for token and session lifetimes.
 *
 * A session expires at the sooner of two deadlines:
 *
 *  - `refreshInactivityTimeoutSeconds` after its newest issued refresh token
 *    was issued, i.e. after its last refresh. Each refresh pushes it later.
 *  - `sessionMaxLifetimeSeconds` after the session was created, however often
 *    it refreshes.
 */
export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshInactivityTimeoutSeconds: number;
  sessionMaxLifetimeSeconds: number;
};

/** The argument validators of a `TtlConfig`, for the component functions. */
export const vTtlConfigFields = {
  accessTokenTtlSeconds: v.number(),
  refreshInactivityTimeoutSeconds: v.number(),
  sessionMaxLifetimeSeconds: v.number(),
};

/**
 * Produces a valid `TtlConfig` from the app's options, filling in the
 * defaults for the values it leaves out. The refresh inactivity timeout
 * defaults to the max lifetime, whether that is the default or the app's. A
 * session's newest token is never older than the session, so at that default
 * only the max lifetime ends a session.
 *
 * Throws when given invalid values.
 */
export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshInactivityTimeoutSeconds?: number;
  sessionMaxLifetimeSeconds?: number;
}): TtlConfig {
  const sessionMaxLifetimeSeconds =
    args.sessionMaxLifetimeSeconds ?? DEFAULT_SESSION_MAX_LIFETIME_SECONDS;
  return validateTtlConfig({
    accessTokenTtlSeconds:
      args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    refreshInactivityTimeoutSeconds:
      args.refreshInactivityTimeoutSeconds ?? sessionMaxLifetimeSeconds,
    sessionMaxLifetimeSeconds,
  });
}

/**
 * Checks a complete `TtlConfig` and returns it.
 *
 * Throws when given invalid values.
 */
export function validateTtlConfig(ttl: TtlConfig): TtlConfig {
  const {
    accessTokenTtlSeconds,
    refreshInactivityTimeoutSeconds,
    sessionMaxLifetimeSeconds,
  } = ttl;
  // Every comparison with `NaN` is false, so check finiteness first.
  if (
    !Number.isFinite(accessTokenTtlSeconds) ||
    !Number.isFinite(refreshInactivityTimeoutSeconds) ||
    !Number.isFinite(sessionMaxLifetimeSeconds)
  ) {
    throw new Error("Token and session lifetimes must be finite numbers.");
  }
  if (
    accessTokenTtlSeconds <= 0 ||
    refreshInactivityTimeoutSeconds <= 0 ||
    sessionMaxLifetimeSeconds <= 0
  ) {
    throw new Error("Token and session lifetimes must be positive.");
  }
  if (accessTokenTtlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error(
      "Access-token TTL must be at most one hour (the deployment refuses " +
        "to sign a longer-lived JWT).",
    );
  }
  if (accessTokenTtlSeconds >= refreshInactivityTimeoutSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh inactivity timeout.",
    );
  }
  // With the check above, this keeps the access-token TTL shorter than the
  // max lifetime too.
  if (refreshInactivityTimeoutSeconds > sessionMaxLifetimeSeconds) {
    throw new Error(
      "Refresh inactivity timeout must be at most the session max lifetime.",
    );
  }
  return {
    accessTokenTtlSeconds,
    refreshInactivityTimeoutSeconds,
    sessionMaxLifetimeSeconds,
  };
}
