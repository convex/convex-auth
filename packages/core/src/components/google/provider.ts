import type { Doc } from "./_generated/dataModel.ts";
import { env, internalMutation, mutation, query } from "./_generated/server.ts";
import { buildProviderFunctions } from "../../lib/oauth/providerFunctions.ts";
import { subClaimAccountId } from "../../lib/oauth/dbHelpers.ts";

export const {
  createAuthorizationRequest,
  claimAuthorizationRequest,
  createTicket,
  redeemTicket,
  linkAccount,
  getUserIdByAccount,
} = buildProviderFunctions<
  Doc<"authorizationRequests">,
  Doc<"tickets">,
  Doc<"accounts">
>({
  query,
  mutation,
  internalMutation,
  clientId: () => env.CLIENT_ID,
  accountId: subClaimAccountId,
});
