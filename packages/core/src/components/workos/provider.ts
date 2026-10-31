/**
 * The mutations WorkOS's component registers over its request and ticket
 * tables.
 *
 * @module
 */
import type { Doc } from "./_generated/dataModel.ts";
import { env, internalMutation, mutation } from "./_generated/server.ts";
import { buildProviderFunctions } from "../../lib/oauth/providerFunctions.ts";

export const {
  createAuthorizationRequest,
  claimAuthorizationRequest,
  createTicket,
  claimTicket,
} = buildProviderFunctions<Doc<"authorizationRequests">, Doc<"tickets">>({
  mutation,
  internalMutation,
  clientId: () => env.CLIENT_ID,
});
