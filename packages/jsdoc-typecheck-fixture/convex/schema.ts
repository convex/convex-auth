import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The impersonation examples read `role`.
  users: defineTable({ role: v.optional(v.string()) }),
});
