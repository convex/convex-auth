// Sessions and the lifecycle of their refresh tokens: issuing, redeeming,
// retiring, and erasing them. The public functions in public.ts build on these.

import type { Doc, Id } from "./_generated/dataModel.ts";
import type { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { generateRefreshToken } from "./crypto.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { TtlConfig } from "./expiry.ts";

// How many issued, never-presented refresh tokens a session may have. Each
// refresh presenting the redeemed token adds one, and the first issued token
// presented clears them all, so the count only climbs when responses are lost
// or refreshes race. A refresh with this many already issued revokes the
// session, unless the redeemed token was redeemed within `REFRESH_GRACE_MS`.
export const STANDARD_ISSUED_REFRESH_TOKEN_LIMIT = 3;
// How long after a token is redeemed it may be presented again without
// counting against `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT`. Concurrent SSR
// requests carrying the same cookie each refresh on their own, and the first to
// land redeems the token the rest present.
export const REFRESH_GRACE_MS = 5 * 1000; // 5 seconds
// How long a spent or dropped refresh token hash is remembered. This is the
// reuse-detection horizon: past it the row is gone and a replayed token reads
// as unknown, which revokes nothing but also grants nothing.
export const SPENT_TOKEN_HORIZON_MS = 60 * 60 * 1000; // 1 hour
// An absolute cap on how many sessions a user may have. A sign-in that would
// exceed it first revokes the sessions that refreshed longest ago. This bounds
// everything that reads all of a user's sessions (`listSessions`, and revoking
// a user's other sessions), which a user whose sessions pile up (e.g. a script
// signing in over and over and not refreshing a prior session) could otherwise
// push past the transaction's limits.
export const MAX_SESSIONS_PER_USER = 100;

/** Look up a refresh token, in any state, by its hash. */
export function lookupRefreshTokenByHash(
  ctx: QueryCtx,
  hash: string,
): Promise<Doc<"refreshTokens"> | null> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
}

/** A session's refresh tokens in one state. */
export function sessionTokensInState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  state: Doc<"refreshTokens">["state"],
): Promise<Doc<"refreshTokens">[]> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) =>
      q.eq("sessionId", sessionId).eq("state", state),
    )
    .collect();
}

/**
 * The session's newest issued refresh token: the one from its sign-in or its
 * latest refresh. It is the session's last token to expire, thus the session
 * expires with it.
 *
 * `null` only for a session with no issued token, which the token lifecycle
 * never leaves (sign-in and each refresh issue one).
 */
export async function newestIssuedToken(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"refreshTokens"> | null> {
  // Issued rows have no `retiredAt`, so the index orders them by
  // `_creationTime`: the last one is the newest.
  return await ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) =>
      q.eq("sessionId", sessionId).eq("state", "issued"),
    )
    .order("desc")
    .first();
}

/**
 * Make room for one more session of the user: while the user has
 * `MAX_SESSIONS_PER_USER` sessions or more, erase the one that refreshed
 * longest ago.
 *
 * A session's last refresh is when its newest issued token was issued (see
 * `listSessions`), so an expired or abandoned session goes before one that a
 * client still keeps fresh, however old that one is.
 */
export async function evictLeastRecentlyRefreshedSessions(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  // Reads every session of the user, which the cap keeps to
  // `MAX_SESSIONS_PER_USER`.
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const excess = sessions.length - MAX_SESSIONS_PER_USER + 1;
  if (excess <= 0) {
    return;
  }
  const byLastRefresh = [];
  for (const session of sessions) {
    const newestIssued = await newestIssuedToken(ctx, session._id);
    byLastRefresh.push({
      sessionId: session._id,
      // A session with no issued token can't refresh, so it goes first.
      lastRefreshedAt: newestIssued?._creationTime ?? -Infinity,
    });
  }
  // `sessions` is in creation order and the sort is stable, so of the
  // sessions that last refreshed at the same time, the oldest goes first.
  byLastRefresh.sort((a, b) => a.lastRefreshedAt - b.lastRefreshedAt);
  for (const { sessionId } of byLastRefresh.slice(0, excess)) {
    await deleteSession(ctx, sessionId);
  }
  console.warn(
    `Evicted ${excess} session${excess > 1 ? "s" : ""} past the ` +
      `${MAX_SESSIONS_PER_USER} session limit for a single user`,
  );
}

/**
 * Erase a session along with every refresh token that points at it.
 *
 * Idempotent, because callers can race: two replays of the same stolen token,
 * or a sign-out arriving alongside one, can both resolve the same session.
 */
export async function deleteSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  // Reads every token row the session has. That is fine at any plausible
  // refresh rate — the horizon divided by the refresh interval, ~60 at the
  // defaults — but it is unbounded in principle. A session refreshed
  // pathologically often could exceed the transaction's limits and make the
  // session unusable.
  const tokens = await ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of tokens) {
    await ctx.db.delete("refreshTokens", row._id);
  }
  // `delete` throws on an id that is already gone, and the session may have
  // been deleted by whoever we raced.
  if ((await ctx.db.get("sessions", sessionId)) !== null) {
    await ctx.db.delete("sessions", sessionId);
  }
}

/**
 * Erase this session's spent and dropped tokens that are past the detection
 * horizon.
 *
 * Spent and dropped tokens are kept to detect illegitimate use of a refresh
 * token. Only a bounded set is kept for that purpose though, thus this code to
 * prune rows retired longer than `SPENT_TOKEN_HORIZON_MS` ago.
 *
 * Cleanup is triggered by redeeming an issued token, so a steadily refreshing
 * session keeps its own set trimmed with no background job to run or mount.
 */
export async function pruneRetiredTokens(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<void> {
  // A session that stops refreshing keeps its remaining rows until it is
  // deleted, since nothing rotates it any more: by sign-out, or by the cleanup
  // loop once it expires. See KNOWN_ISSUES.md.
  for (const state of ["spent", "dropped"] as const) {
    const expired = await ctx.db
      .query("refreshTokens")
      .withIndex("by_session_state", (q) =>
        q
          .eq("sessionId", sessionId)
          .eq("state", state)
          .lte("retiredAt", now - SPENT_TOKEN_HORIZON_MS),
      )
      .collect();
    for (const row of expired) {
      await ctx.db.delete("refreshTokens", row._id);
    }
  }
}

/**
 * Issue a new refresh token for a session.
 *
 * Returns the raw token, and stores its hash for later lookup. The returned
 * `expiresAt` holds under the current TTL; a later change to the TTL moves it.
 * It is computed from `now` rather than the row's `_creationTime`, so it can
 * differ from what `refresh` enforces by a fraction of a millisecond.
 */
export async function issueRefreshToken(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
  ttl: TtlConfig,
): Promise<{ refreshToken: string; expiresAt: number }> {
  const refreshToken = generateRefreshToken();
  await ctx.db.insert("refreshTokens", {
    hash: await sha256Hex(refreshToken),
    sessionId,
    state: "issued",
  });
  return {
    refreshToken,
    expiresAt: now + ttl.refreshTokenTtlSeconds * 1000,
  };
}

/**
 * Redeem an issued token, the first time it is presented.
 *
 * Its holder has evidently received it, so the session's previously redeemed
 * token is marked as spent and the other issued tokens, which nobody should
 * ever present, are marked as dropped.
 */
export async function redeem(
  ctx: MutationCtx,
  token: Doc<"refreshTokens">,
  now: number,
): Promise<void> {
  const redeemed = await sessionTokensInState(ctx, token.sessionId, "redeemed");
  if (redeemed.length > 1) {
    throw new Error(
      "Invariant violation: a session has more than one redeemed refresh token",
    );
  }
  // There will be 0 or 1 tokens in the `redeemed`` state.
  for (const row of redeemed) {
    await ctx.db.patch("refreshTokens", row._id, {
      state: "spent",
      retiredAt: now,
    });
  }
  for (const row of await sessionTokensInState(
    ctx,
    token.sessionId,
    "issued",
  )) {
    if (row._id === token._id) continue;
    await ctx.db.patch("refreshTokens", row._id, {
      state: "dropped",
      retiredAt: now,
    });
  }
  await ctx.db.patch("refreshTokens", token._id, { state: "redeemed" });

  // Remove any spent and dropped tokens past the `SPENT_TOKEN_HORIZON_MS`.
  await pruneRetiredTokens(ctx, token.sessionId, now);
}
