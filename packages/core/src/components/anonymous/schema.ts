import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Connects each anonymous id to its app user id. An anonymous identity is
  // never signed in again, so nothing looks these rows up and the table has
  // no index.
  accounts: defineTable({
    anonymousId: v.string(),
    userId: v.string(),
  }),
});
