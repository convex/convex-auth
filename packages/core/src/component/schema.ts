import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The IDs of the app users that the core created or signed in, or that the
  // app marked as created (`markUserIdCreated`).
  createdUserIds: defineTable({
    userId: v.string(),
  }).index("by_userId", ["userId"]),

  // One row per active session. Its refresh tokens live in `refreshTokens`.
  // A session expires once it goes `refreshInactivityTimeoutSeconds` without a
  // refresh, or at the latest `sessionMaxLifetimeSeconds` after its
  // `_creationTime`, under the values configured when it is checked.
  // The row is only written when the session is created or deleted, so a query
  // reading it (e.g. to check session liveness) is not invalidated by token
  // refreshes. The one exception is an impersonation session, which is patched
  // when it is stopped, and once more if its impersonator session then starts
  // another impersonation.
  //
  // An impersonation session is a session of the target user (`userId`) that
  // an impersonator started from their own session, the impersonator session.
  // The two end together: deleting either deletes the other, except that
  // stopping the impersonation ends it and keeps the impersonator session.
  // While an impersonator session has an impersonation that is not stopped, it
  // is suspended and cannot be refreshed (see `refresh`).
  sessions: defineTable({
    userId: v.string(),
    // The path of the component that authenticated the user when the session
    // was created, for example `"authPassword"`. The core's own path for an
    // impersonation session, which no sign-in component authenticated.
    component: v.string(),
    // Present only on an impersonation session.
    impersonation: v.optional(
      v.object({
        // The user who started the impersonation.
        impersonatorUserId: v.string(),
        // The impersonator's own session, which stopping resumes.
        impersonatorSessionId: v.id("sessions"),
        // When the impersonation ends, in ms since the epoch. Fixed at
        // creation, and never later than the impersonator session's max
        // lifetime at that time.
        expiresAt: v.number(),
        // Set once, when the impersonation is stopped. The row is deleted
        // `IMPERSONATION_STOP_GRACE_MS` later, and `getSession`, `refresh`,
        // and `_internal_dangerous_stopImpersonation` refuse it past that
        // deadline even if deletion is delayed.
        stoppedAt: v.optional(v.number()),
        // Set once, on a stopped impersonation, when its impersonator session
        // starts another one. Only the newest impersonation of a session can
        // restore it, even after a newer one is deleted.
        supersededAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_impersonatorSession", ["impersonation.impersonatorSessionId"]),

  // Every refresh token a session has handed out and still remembers, by its
  // SHA-256 hash. The raw refresh token is never stored.
  //
  // A token's `state` is one of:
  //
  //  - `issued`: handed to a client, but not yet redeemed. Sign-in issues the
  //    session's first token, and each refresh issues another.
  //  - `redeemed`: presented once, so its holder evidently received it.
  //    Presenting it again issues another token and leaves it redeemed, which
  //    is what lets a client whose refresh response was lost (a device
  //    sleeping mid-request) retry with the token it still holds.
  //  - `spent`: a redeemed token, replaced when a later issued token was
  //    redeemed. Its holder has moved on.
  //  - `dropped`: an issued token discarded when a sibling was redeemed.
  //    Whoever holds it forked from the holder of the redeemed one.
  //
  // Presenting an issued token redeems it, spends the session's previous
  // redeemed token, and drops the other issued ones, so a session has at most
  // one redeemed token (none before its first refresh), and every issued token
  // descends from it. Presenting a spent or dropped token means the session's
  // holders have diverged, which revokes the session. Spent and dropped rows
  // are kept for `SPENT_TOKEN_HORIZON_MS` after `retiredAt`, then pruned.
  //
  // Each refresh inserts a row, so a session's freshness (when it last
  // refreshed) can be derived from the `_creationTime` of its newest row via
  // the `by_session_state` index; the session row itself stores no timestamp.
  //
  // A token stores no expiry: it expires `refreshInactivityTimeoutSeconds`
  // after its `_creationTime`, under the timeout configured when it is checked
  // (and with its session, at the session's max lifetime). A changed timeout
  // thus applies to every outstanding token, not just the ones issued after the
  // change.
  refreshTokens: defineTable({
    hash: v.string(),
    sessionId: v.id("sessions"),
    state: v.union(
      v.literal("issued"),
      v.literal("redeemed"),
      v.literal("spent"),
      v.literal("dropped"),
    ),
    // When the token became spent or dropped.
    retiredAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_session_state", ["sessionId", "state", "retiredAt"]),

  // The session lifetimes the app last passed in, so that background jobs,
  // which run with no caller to pass them, know when a session expires. At
  // most one row. The functions that take the lifetimes as args (sign-in and
  // refresh) write it when the values they get differ from the stored ones,
  // which is rare, thus reading it on every refresh stays cheap.
  ttlConfig: defineTable({
    refreshInactivityTimeoutSeconds: v.number(),
    sessionMaxLifetimeSeconds: v.number(),
  }),
});
