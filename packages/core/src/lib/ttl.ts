import { v } from "convex/values";

// Defaults for the configurable token lifetimes. The app overrides them per
// deployment via `setupConvexAuth`, which resolves the full configuration once
// and passes it to the core component on every call.
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// `ctx.auth.signJwt` refuses to mint a token that lives longer than an hour,
// so an access-token TTL past that is a misconfiguration.
const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * The token lifetimes for a call, with the app's overrides applied over the
 * defaults. Validated so a misconfiguration fails loudly rather than minting
 * nonsensical sessions.
 */
export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

/** The argument validators of a `TtlConfig`, for the component functions. */
export const vTtlConfigFields = {
  accessTokenTtlSeconds: v.number(),
  refreshTokenTtlSeconds: v.number(),
};

/**
 * Produces a valid `TtlConfig` from the app's options, filling in the
 * defaults for the values it leaves out.
 *
 * Throws when given invalid values.
 */
export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}): TtlConfig {
  return validateTtlConfig({
    accessTokenTtlSeconds:
      args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds:
      args.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  });
}

/**
 * Checks a complete `TtlConfig` and returns it.
 *
 * Throws when given invalid values.
 */
export function validateTtlConfig(ttl: TtlConfig): TtlConfig {
  const { accessTokenTtlSeconds, refreshTokenTtlSeconds } = ttl;
  // Every comparison with `NaN` is false, so check finiteness first.
  if (
    !Number.isFinite(accessTokenTtlSeconds) ||
    !Number.isFinite(refreshTokenTtlSeconds)
  ) {
    throw new Error("Token TTLs must be finite numbers.");
  }
  if (accessTokenTtlSeconds <= 0 || refreshTokenTtlSeconds <= 0) {
    throw new Error("Token TTLs must be positive.");
  }
  if (accessTokenTtlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error(
      "Access-token TTL must be at most one hour (the deployment refuses " +
        "to sign a longer-lived JWT).",
    );
  }
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh-token TTL.",
    );
  }
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}
