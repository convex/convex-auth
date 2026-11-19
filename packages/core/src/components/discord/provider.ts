import type { Doc } from "./_generated/dataModel.ts";
import { env, internalMutation, mutation, query } from "./_generated/server.ts";
import { buildProviderFunctions } from "../../lib/oauth/providerFunctions.ts";

export const {
  _internal_dangerous_createAuthorizationRequest,
  claimAuthorizationRequest,
  createTicket,
  claimTicket,
  getUserIdByAccount,
  _internal_dangerous_createAccount,
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
