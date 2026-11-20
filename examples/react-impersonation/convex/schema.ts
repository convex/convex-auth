import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    // What the user may do in the app. Convex Auth knows nothing about roles:
    // the app's `authorizeImpersonation` rule reads this field.
    role: v.union(v.literal("admin"), v.literal("member")),
  }),
  // One row per impersonation that started, for audits.
  impersonationLog: defineTable({
    impersonatorUserId: v.id("users"),
    targetUserId: v.id("users"),
  }),
});
