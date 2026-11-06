/**
 * The functions Apple's component registers over its own three tables.
 *
 * @module
 */
import type { Doc } from "./_generated/dataModel.ts";
import { env, internalMutation, mutation, query } from "./_generated/server.ts";
import { buildProviderFunctions } from "../../lib/oauth/providerFunctions.ts";

export const {
  createAuthorizationRequest,
  claimAuthorizationRequest,
  createTicket,
  claimTicket,
  getUserIdByAccount,
  createAccount,
} = buildProviderFunctions<
  Doc<"authorizationRequests">,
  Doc<"tickets">,
  Doc<"accounts">
>({
  query,
  mutation,
  internalMutation,
  clientId: () => env.CLIENT_ID,
});
