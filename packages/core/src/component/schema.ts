import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authConfiguration } from "../lib/configuration.ts";

export default defineSchema({
  configuration: defineTable(authConfiguration),
  // Maps a provider-scoped identity to an opaque app user id. The app owns the
  // actual users table; we only store the id string it gives us back.
  accounts: defineTable({
    provider: v.string(),
    providerAccountId: v.string(),
    userId: v.string(),
  })
    .index("by_provider_account", ["provider", "providerAccountId"])
    .index("by_user", ["userId"]),

  // One row per active session. Its refresh tokens live in `refreshTokens`.
  sessions: defineTable({
    userId: v.string(),
    accountId: v.id("accounts"),
    lastRefreshedAt: v.number(),
  }).index("by_user", ["userId"]),

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
  refreshTokens: defineTable({
    hash: v.string(),
    sessionId: v.id("sessions"),
    state: v.union(
      v.literal("issued"),
      v.literal("redeemed"),
      v.literal("spent"),
      v.literal("dropped"),
    ),
    expiresAt: v.number(),
    // When the token became spent or dropped.
    retiredAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_session_state", ["sessionId", "state", "retiredAt"]),
});
