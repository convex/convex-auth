import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Connects each anonymous id to its app user id. An anonymous identity is
  // never signed in again, so nothing looks these rows up by anonymous id.
  accounts: defineTable({
    anonymousId: v.string(),
    userId: v.string(),
  })
    .index("by_anonymousId", ["anonymousId"])
    .index("by_userId", ["userId"]),
});
