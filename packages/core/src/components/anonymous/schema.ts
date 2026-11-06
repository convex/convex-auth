import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per anonymous sign-in: the identity the sign-in method minted
  // for it, and the app user the core created. Nothing resolves an anonymous
  // identity back to its user today (there is no returning with a previous
  // anonymous account), so the row is a record, not a lookup.
  accounts: defineTable({
    anonymousId: v.string(),
    userId: v.string(),
  })
    .index("by_anonymousId", ["anonymousId"])
    .index("by_userId", ["userId"]),
});
