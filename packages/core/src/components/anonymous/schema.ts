import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per anonymous user, holding its app user id. An anonymous
  // identity is never signed in again, so nothing looks these rows up and
  // the table has no index.
  accounts: defineTable({
    userId: v.string(),
  }),
});
