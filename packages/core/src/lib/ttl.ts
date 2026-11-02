// Defaults for the configurable token lifetimes. The app overrides them per
// deployment via `setupConvexAuth`, which threads the chosen values in as call
// args to the core component; when it passes nothing, these apply. They live
// here because the app side needs them too: it derives a session's expiry
// from its `lastRefreshedAt` (see `listSessions`).
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
