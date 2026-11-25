import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// `lastSignedInAt` is maintained by this app's own callbacks (see convex/users.ts).
export default defineSchema({
  users: defineTable({
    lastSignedInAt: v.optional(v.number()),
    githubLogin: v.optional(v.string()),
  }),
});
