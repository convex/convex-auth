import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  accountsTable,
  authorizationRequestFields,
  ticketFields,
} from "../../lib/oauth/schema.ts";

export default defineSchema({
  authorizationRequests: defineTable({
    ...authorizationRequestFields,
    /** Provider the request was issued for, e.g. "acme". */
    providerName: v.string(),
    // Older versions stored the endpoints of the provider on the request.
    // The component now reads them from its env. The fields stay optional,
    // thus requests that exist during an upgrade keep the schema valid.
    tokenEndpoint: v.optional(v.string()),
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    issuers: v.optional(v.array(v.string())),
  }).index("stateHash", ["stateHash"]),

  tickets: defineTable({
    ...ticketFields,
    /** Provider that authenticated the user, e.g. "acme". */
    providerName: v.string(),
  }).index("ticketCodeHash", ["ticketCodeHash"]),

  accounts: accountsTable,
});
