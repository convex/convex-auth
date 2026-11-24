import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The schema of the Resend stub component. Tests read this table to see
// the emails the code under test sent.
export default defineSchema({
  emails: defineTable({
    from: v.string(),
    to: v.array(v.string()),
    subject: v.optional(v.string()),
    html: v.optional(v.string()),
    text: v.optional(v.string()),
    headers: v.optional(
      v.array(v.object({ name: v.string(), value: v.string() })),
    ),
  }),
});
