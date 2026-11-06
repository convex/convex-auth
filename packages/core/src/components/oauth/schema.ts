import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  accountFields,
  authorizationRequestFields,
  ticketFields,
} from "../../lib/oauth/schema.ts";

export default defineSchema({
  authorizationRequests: defineTable({
    ...authorizationRequestFields,
    /** Provider the request was issued for, e.g. "acme". */
    providerName: v.string(),
    /** The provider's token endpoint URL. */
    tokenEndpoint: v.string(),
    /**
     * Profile endpoints URLs to fetch with the access token after
     * the exchange, keyed by the name the app's `profile` mapping receives
     * each response under.
     */
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    /**
     * Accepted `iss` (the OIDC issuer claim) values for the provider's
     * id_tokens, copied from app-side config. Absent for non-oidc providers.
     */
    issuers: v.optional(v.array(v.string())),
  }).index("stateHash", ["stateHash"]),

  tickets: defineTable({
    ...ticketFields,
    /** Provider that authenticated the user, e.g. "acme". */
    providerName: v.string(),
  }).index("ticketCodeHash", ["ticketCodeHash"]),

  // One component instance can serve several providers, so an account is
  // keyed by the provider's name as well as its account id: two providers
  // may well both number their users from 1.
  accounts: defineTable({
    ...accountFields,
    /** Provider the account belongs to, e.g. "acme". */
    providerName: v.string(),
  })
    .index("providerAccountId", ["providerAccountId"])
    .index("userId", ["userId"]),
});
