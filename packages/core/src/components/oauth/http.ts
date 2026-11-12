/**
 * The custom-provider callback.
 *
 * @module
 */
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api.ts";
import { env } from "./_generated/server.ts";
import type { ClaimedRequest } from "../../lib/oauth/callback.ts";
import { buildCallbackRouter } from "../../lib/oauth/http.ts";
import { providerConfig } from "./config.ts";

/** What this component's claimed authorization request has, past the basics. */
type CustomProviderRequest = ClaimedRequest & {
  providerName: string;
};

const http: HttpRouter = buildCallbackRouter<CustomProviderRequest>({
  methods: ["GET", "POST"],
  claim: (ctx, stateHash) =>
    ctx.runMutation(internal.provider.claimAuthorizationRequest, { stateHash }),
  mintTicket: (ctx, request, ticket) =>
    ctx.runMutation(internal.provider.createTicket, {
      providerName: request.providerName,
      stateHash: request.stateHash,
      ...ticket,
    }),
  // The endpoints come from the env of the component instance.
  exchangeConfig: (request) => {
    const config = providerConfig();
    return {
      providerName: request.providerName,
      tokenEndpoint: config.tokenEndpoint,
      clientId: env.CLIENT_ID,
      clientSecret: () => env.CLIENT_SECRET,
      issuers: config.issuers,
      userInfoEndpoints: config.userInfoEndpoints,
    };
  },
});

export default http;
