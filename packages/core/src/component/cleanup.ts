// The background loops that erase expired sessions. `refresh` refuses an
// expired session on its own, so the loops don't enforce expiry: they make a
// session's row, which `getSession` reads for liveness, go away once the
// session can no longer refresh. Without them, the row of a session that
// nobody refreshes again would stay forever.
//
// A session expires at the sooner of two deadlines, and each has a loop:
//
//  - The inactivity loop erases a session one inactivity timeout after its
//    newest issued token was issued. It scans the issued tokens.
//  - The max-lifetime loop erases a session one max lifetime after it was
//    created, however recently it refreshed. It scans the sessions.
//
// The lifetimes are the app's config, which the app passes in as call args,
// thus the loops read the copy that sign-in and refresh store (see
// `recordTtlConfig`). Each run reads it afresh, so a changed lifetime applies
// to every session, in either direction.
//
// The loops are tuned to be conservative in batch size and throughput.
// Typically they process few sessions at a time, but when many expire at once
// (e.g. after a lifetime is lowered), each erased session schedules the
// erasure of its tokens, so the loops pace themselves to work through the
// backlog without swamping the scheduler (see `BATCH_INTERVAL_MS`).

import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";
import {
  refreshTokenInactivityExpiresAt,
  sessionMaxLifetimeExpiresAt,
  storedTtlConfig,
} from "./expiry.ts";
import { deleteSession, newestIssuedToken } from "./sessions.ts";

// The names of the batch worker loops that erase expired sessions. One loop of
// each kind is necessary, so the names are constant.
export const INACTIVITY_WORKER_NAME = "inactiveSessions";
export const MAX_LIFETIME_WORKER_NAME = "maxLifetimeSessions";

// How many expired rows one worker mutation handles, in either loop. Each one
// maps to a session, so this is effectively the max number of expired sessions
// deleted in a batch. Deleting a session takes a few reads and writes, and
// schedules the erasure of its refresh tokens (see `deleteSession`), so the
// batch stays far below the transaction's limit of 1000 scheduled functions.
// A mutation over the limits would throw on every retry, and the loop would
// hand out the same batch forever.
export const BATCH_SIZE = 100;

// How long a loop waits after a full batch before it handles the next one.
// Each erased session schedules one `deleteSessionTokens`, and the scheduler
// runs as few as 8 jobs at once (Free/Starter), a limit shared with the app's
// own scheduled functions. A large backlog of expired sessions (e.g. after a
// lifetime is lowered) would otherwise flood that queue as fast as the loop
// can find them. With the batch size, this caps each loop at 50 sessions per
// second. A batch that is not full drains the backlog, so the loop doesn't
// wait after it.
export const BATCH_INTERVAL_MS = 2_000;

/**
 * What a worker mutation returns to the batch worker: the cursor to move back
 * to, if it kept a row, and a wait before the next batch, if this one was full.
 */
function workerResult(
  batchLength: number,
  keptFrom: number | undefined,
): { cursor?: number; debounceMs?: number } | null {
  const full = batchLength >= BATCH_SIZE;
  if (keptFrom === undefined && !full) {
    return null;
  }
  return {
    ...(keptFrom !== undefined && { cursor: keptFrom }),
    ...(full && { debounceMs: BATCH_INTERVAL_MS }),
  };
}

// The longest a loop sleeps between checks. The next expiry is often a whole
// lifetime away (30 days by default), which is longer than a JavaScript timer
// can wait (about 24.8 days; convex-test fires a longer one at once). A daily
// check costs one query, and it also bounds how late the loop notices
// anything that its wake-up time didn't account for.
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Make sure that both background cleanup loops run.
 *
 * Call this function after a session starts, and after the stored lifetimes
 * change. The call is cheap: it does nothing while a loop already runs or
 * waits. While any session exists, each loop sleeps until the next one may
 * expire under its rule; it goes idle when no session stays.
 *
 * A refresh doesn't ping: it only pushes its session's inactivity expiry later
 * (and never moves its max lifetime), and the loops check again when they wake
 * up.
 */
export async function scheduleSessionCleanup(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, {
    name: INACTIVITY_WORKER_NAME,
    workQuery: internal.cleanup.getExpiredTokens,
    workerMutation: internal.cleanup.deleteExpiredTokens,
  });
  await ping(ctx, components.batchWorker, {
    name: MAX_LIFETIME_WORKER_NAME,
    workQuery: internal.cleanup.getSessionsPastMaxLifetime,
    workerMutation: internal.cleanup.deleteSessionsPastMaxLifetime,
  });
}

// --- The inactivity loop ---------------------------------------------------

const vTokenEvents = v.array(v.object({ id: v.id("refreshTokens") }));

const inactivityValidators = defineBatchWorkerValidators({
  batch: { events: vTokenEvents },
  // The cursor is the `_creationTime` of the last issued token that the loop
  // handled. Every issued token below it is gone (see `deleteExpiredTokens`),
  // thus the next scan starts at it and does not read their tombstones.
  //
  // The batch worker docs warn that `_creationTime` is assigned when a mutation
  // starts, so a slow mutation can insert a row behind the cursor. The scan
  // only reads tokens older than one inactivity timeout, and no mutation runs
  // that long, thus no token can land behind it.
  cursor: v.number(),
});

/**
 * Find the next batch of issued tokens that are past the inactivity timeout.
 *
 * A session's issued tokens are the ones from its sign-in or its refreshes
 * that nobody presented yet, and its newest token is always issued. Thus a
 * session whose every issued token is past the timeout is expired, and
 * scanning the issued tokens oldest first finds the inactive sessions in the
 * order in which they expired.
 *
 * When no token is expired, the loop goes idle. If issued tokens stay, the
 * loop also gets a timeout: it wakes up again when the oldest of them expires
 * (or after `MAX_SLEEP_MS`, if sooner), even if no new session starts. That token may since have been redeemed, in
 * which case the wake-up finds nothing and sleeps until the next one.
 */
export const getExpiredTokens = internalQuery({
  args: inactivityValidators.vQueryArgs,
  returns: inactivityValidators.vQueryReturns,
  handler: async (ctx, args) => {
    const stored = await storedTtlConfig(ctx);
    // No sign-in or refresh has stored the lifetimes yet, and those are what
    // ping the loop, thus this is only reachable through a manual start.
    if (stored === null) {
      return { kind: "idle" as const };
    }
    const timeoutSeconds = stored.refreshInactivityTimeoutSeconds;
    const now = Date.now();
    // The upper bound keeps the read to the expired rows. The newest issued
    // tokens, the ones each refresh inserts, are past it, so this scan doesn't
    // touch the part of the index that refreshes write to.
    const expired = await ctx.db
      .query("refreshTokens")
      .withIndex("by_state", (q) =>
        q
          .eq("state", "issued")
          .eq("retiredAt", undefined)
          // The bound is inclusive because two rows can share a creation
          // time: the row at the cursor is erased, but a twin of it can stay.
          .gte("_creationTime", args.cursor ?? 0)
          // The boundary matches `refresh`: at exactly the timeout, a token
          // is expired. A wake-up at the deadline thus finds work.
          .lte("_creationTime", now - timeoutSeconds * 1000),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { events: expired.map((row) => ({ id: row._id })) },
        // The component commits the cursor with the batch, thus it only moves
        // if the rows are really erased.
        cursor: expired[expired.length - 1]._creationTime,
      };
    }
    // Nothing to erase now. The oldest remaining issued token is the first
    // one that expires. No issued row below the cursor stays, thus the same
    // lower bound applies here. `first` reads only up to that row.
    const oldest = await ctx.db
      .query("refreshTokens")
      .withIndex("by_state", (q) =>
        q
          .eq("state", "issued")
          .eq("retiredAt", undefined)
          .gte("_creationTime", args.cursor ?? 0),
      )
      .first();
    if (oldest === null) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.min(
        MAX_SLEEP_MS,
        Math.max(
          0,
          refreshTokenInactivityExpiresAt(oldest, timeoutSeconds) - Date.now(),
        ),
      ),
    };
  },
});

/**
 * Erase one batch of expired issued tokens, and with each session's newest
 * one, the session.
 *
 * The query ran on a snapshot that takes no read dependencies, thus each token
 * is checked again here. A token that was redeemed or retired since is no
 * longer this loop's to handle. A token that the stored inactivity timeout no
 * longer expires (it was raised in between) is kept, and the cursor is moved
 * back to it so that a later scan finds it again.
 *
 * An expired token that is not its session's newest issued one is a sibling
 * whose response was lost; the session lives on through the newer token.
 * Nobody can refresh with it any more, so only the token is erased. So is a
 * token whose session was deleted already, before its erasure got to it. That
 * keeps the rule of the cursor: every issued token below it is gone.
 */
export const deleteExpiredTokens = internalMutation({
  args: inactivityValidators.vMutationArgs,
  returns: inactivityValidators.vMutationReturns,
  handler: async (ctx, { events }) => {
    const stored = await storedTtlConfig(ctx);
    if (stored === null) {
      throw new Error(
        "Invariant violation: the inactivity cleanup loop ran with no " +
          "stored lifetimes",
      );
    }
    const timeoutSeconds = stored.refreshInactivityTimeoutSeconds;
    const now = Date.now();
    let keptFrom: number | undefined;
    for (const { id } of events) {
      const token = await ctx.db.get("refreshTokens", id);
      if (token === null || token.state !== "issued") continue;
      if (refreshTokenInactivityExpiresAt(token, timeoutSeconds) > now) {
        keptFrom = Math.min(keptFrom ?? Infinity, token._creationTime);
        continue;
      }
      // A token whose session is gone already waits for
      // `deleteSessionTokens`. Erasing it here too keeps the rule of the
      // cursor.
      const session = await ctx.db.get("sessions", token.sessionId);
      if (
        session !== null &&
        (await newestIssuedToken(ctx, token.sessionId))?._id === token._id
      ) {
        await deleteSession(ctx, token.sessionId);
      } else {
        await ctx.db.delete("refreshTokens", token._id);
      }
    }
    return workerResult(events.length, keptFrom);
  },
});

// --- The max-lifetime loop -------------------------------------------------

const vSessionEvents = v.array(v.object({ id: v.id("sessions") }));

const maxLifetimeValidators = defineBatchWorkerValidators({
  batch: { events: vSessionEvents },
  // The cursor is the `_creationTime` of the last session that the loop
  // handled. Every session below it is gone (see
  // `deleteSessionsPastMaxLifetime`), thus the next scan starts at it and
  // does not read their tombstones. As with the inactivity loop, the scan only
  // reads sessions older than one max lifetime, thus no session can land
  // behind it.
  cursor: v.number(),
});

/**
 * Find the next batch of sessions that are past the max lifetime.
 *
 * Scanning the sessions oldest first finds them in the order in which they
 * reach it. When none is past it, the loop goes idle, with a timeout that
 * wakes it when the oldest remaining session reaches it (or after
 * `MAX_SLEEP_MS`, if sooner). That session may since have been erased
 * otherwise, in which case the wake-up finds nothing and sleeps until the
 * next one.
 */
export const getSessionsPastMaxLifetime = internalQuery({
  args: maxLifetimeValidators.vQueryArgs,
  returns: maxLifetimeValidators.vQueryReturns,
  handler: async (ctx, args) => {
    const stored = await storedTtlConfig(ctx);
    // See `getExpiredTokens`: only reachable through a manual start.
    if (stored === null) {
      return { kind: "idle" as const };
    }
    const maxLifetimeSeconds = stored.sessionMaxLifetimeSeconds;
    const now = Date.now();
    const expired = await ctx.db
      .query("sessions")
      .withIndex("by_creation_time", (q) =>
        q
          // Inclusive for the same reason as in `getExpiredTokens`.
          .gte("_creationTime", args.cursor ?? 0)
          // The boundary matches `refresh`: at exactly the max lifetime, a
          // session is expired.
          .lte("_creationTime", now - maxLifetimeSeconds * 1000),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { events: expired.map((row) => ({ id: row._id })) },
        cursor: expired[expired.length - 1]._creationTime,
      };
    }
    const oldest = await ctx.db
      .query("sessions")
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", args.cursor ?? 0),
      )
      .first();
    if (oldest === null) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.min(
        MAX_SLEEP_MS,
        Math.max(
          0,
          sessionMaxLifetimeExpiresAt(oldest, maxLifetimeSeconds) - Date.now(),
        ),
      ),
    };
  },
});

/**
 * Erase one batch of sessions past the max lifetime.
 *
 * Each session is checked again, as in `deleteExpiredTokens`. A session that
 * is gone already was erased otherwise. A session that the stored max
 * lifetime no longer expires (it was raised in between) is kept, and the
 * cursor is moved back to it so that a later scan finds it again.
 */
export const deleteSessionsPastMaxLifetime = internalMutation({
  args: maxLifetimeValidators.vMutationArgs,
  returns: maxLifetimeValidators.vMutationReturns,
  handler: async (ctx, { events }) => {
    const stored = await storedTtlConfig(ctx);
    if (stored === null) {
      throw new Error(
        "Invariant violation: the max-lifetime session cleanup loop ran " +
          "with no stored lifetimes",
      );
    }
    const now = Date.now();
    let keptFrom: number | undefined;
    for (const { id } of events) {
      const session = await ctx.db.get("sessions", id);
      if (session === null) continue;
      if (
        sessionMaxLifetimeExpiresAt(session, stored.sessionMaxLifetimeSeconds) >
        now
      ) {
        keptFrom = Math.min(keptFrom ?? Infinity, session._creationTime);
        continue;
      }
      await deleteSession(ctx, session._id);
    }
    return workerResult(events.length, keptFrom);
  },
});
