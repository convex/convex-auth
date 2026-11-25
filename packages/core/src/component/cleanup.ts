// The background loop that erases expired sessions. `refresh` refuses an
// expired session on its own, so the loop doesn't enforce expiry: it simply
// cleans up sessions that have expired and can no longer be refreshed.
//
// A session expires at the sooner of two deadlines: one inactivity timeout
// after its newest issued token was issued, or one max lifetime after it was
// created. This loop erases sessions once they reach their max lifetime.
//
// The lifetimes are set by the app and the loop sees updated values any time
// a session is created or refreshed (see `recordTtlConfig`).
//
// The loop is tuned to be conservative in batch size and throughput.
// Typically it processes few sessions at a time, but when many expire at once
// (e.g. after a lifetime is lowered), each erased session schedules the
// erasure of its tokens, so the loop paces itself to work through the
// backlog without swamping the scheduler (see `BATCH_INTERVAL_MS`).

import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";
import { sessionMaxLifetimeExpiresAt, storedTtlConfig } from "./expiry.ts";
import { deleteSession } from "./sessions.ts";

// The name of the batch worker loop that erases expired sessions. One loop is
// necessary, so the name is constant.
export const MAX_LIFETIME_WORKER_NAME = "maxLifetimeSessions";

// How many expired rows one worker mutation handles. If there are many sessions
// to clean up, this keeps the operations within the transaction limits.
export const BATCH_SIZE = 100;

// How long the loop waits after a full batch before it handles the next one.
// Cleanup is not an urgent task and this delay helps avoid racing to complete
// when there is a backlog of work.
export const BATCH_INTERVAL_MS = 2_000;

/**
 * What a worker mutation returns to the batch worker: the cursor to move back
 * to when resuming, if it found a row now unexpired, and a wait before the
 * next batch, if this one was full.
 */
function workerResult(
  batchLength: number,
  resumeAtTimestamp: number | undefined,
): { cursor?: number; debounceMs?: number } | null {
  const full = batchLength >= BATCH_SIZE;
  if (resumeAtTimestamp === undefined && !full) {
    return null;
  }
  return {
    ...(resumeAtTimestamp !== undefined && { cursor: resumeAtTimestamp }),
    ...(full && { debounceMs: BATCH_INTERVAL_MS }),
  };
}

// The longest the loop sleeps between checks.
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Make sure that the background cleanup loop runs.
 *
 * Call this function after a session starts, and after the stored lifetimes
 * change.
 */
export async function scheduleSessionCleanup(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, {
    name: MAX_LIFETIME_WORKER_NAME,
    workQuery: internal.cleanup.getSessionsPastMaxLifetime,
    workerMutation: internal.cleanup.deleteSessionsPastMaxLifetime,
  });
}

// --- The max-lifetime loop -------------------------------------------------

const vSessionEvents = v.array(v.object({ id: v.id("sessions") }));

const maxLifetimeValidators = defineBatchWorkerValidators({
  batch: { events: vSessionEvents },
  // The cursor is the `_creationTime` of the last session that the loop
  // handled. Every session older than it is gone (see
  // `deleteSessionsPastMaxLifetime`), thus the next scan starts at it and
  // does not read their tombstones.
  //
  // The batch worker docs warn that `_creationTime` is assigned when a mutation
  // starts, so a slow mutation can insert a row behind the cursor. In the case of
  // sessions, they are created well ahead of expiration so there's no chance of
  // new records racing in behind `_creationTime`.
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
    // No sign-in or refresh has stored the lifetimes yet, and those are what
    // ping the loop, thus this is only reachable through a manual start.
    if (stored === null) {
      return { kind: "idle" as const };
    }
    const maxLifetimeSeconds = stored.sessionMaxLifetimeSeconds;
    const now = Date.now();
    const expired = await ctx.db
      .query("sessions")
      .withIndex("by_creation_time", (q) =>
        q
          .gte("_creationTime", args.cursor ?? 0)
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
    // Nothing to erase now. Idle the loop until the oldest session is ready to
    // expire, or `MAX_SLEEP_MS`.
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
 * The query ran on a snapshot that takes no read dependencies, thus each
 * session is checked again here. A session that is gone already was erased
 * otherwise. A session that the stored max lifetime no longer expires (it was
 * raised in between) is kept, and the cursor is moved back to it so that a
 * later scan finds it again.
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
    let resumeAtTimestamp: number | undefined;
    for (const { id } of events) {
      const session = await ctx.db.get("sessions", id);
      if (session === null) continue;
      if (
        sessionMaxLifetimeExpiresAt(session, stored.sessionMaxLifetimeSeconds) >
        now
      ) {
        resumeAtTimestamp = Math.min(
          resumeAtTimestamp ?? Infinity,
          session._creationTime,
        );
        continue;
      }
      await deleteSession(ctx, session._id);
    }
    return workerResult(events.length, resumeAtTimestamp);
  },
});
