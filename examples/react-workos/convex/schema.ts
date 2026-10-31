import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
    organizationId: v.optional(v.string()),
    idpId: v.string(),
    /** Set when the customer's directory deprovisioned the user. */
    deprovisioned: v.optional(v.boolean()),
  }).index("organizationId_idpId", ["organizationId", "idpId"]),
});
