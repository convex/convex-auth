/**
 * WorkOS's routes: the SSO callback, and the webhook that keeps the copy of
 * the environment current.
 *
 * @module
 */
import { httpActionGeneric, type HttpRouter } from "convex/server";
import { api, internal } from "./_generated/api.ts";
import { env } from "./_generated/server.ts";
import type { ClaimedRequest } from "../../lib/oauth/callback.ts";
import { buildCallbackRouter } from "../../lib/oauth/http.ts";
import {
  PROVIDER_NAME,
  TOKEN_ENDPOINT,
  USER_INFO_ENDPOINTS,
} from "./constants.ts";
import { verifyWebhookSignature } from "./webhook.ts";
import { read } from "./reconcile.ts";
import { decodeEvent } from "./wire.ts";

const http: HttpRouter = buildCallbackRouter<ClaimedRequest>({
  claim: (ctx, stateHash) =>
    ctx.runMutation(internal.provider.claimAuthorizationRequest, { stateHash }),
  mintTicket: (ctx, request, ticket) =>
    ctx.runMutation(internal.provider.createTicket, {
      stateHash: request.stateHash,
      ...ticket,
    }),
  exchangeConfig: () => ({
    providerName: PROVIDER_NAME,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: env.CLIENT_ID,
    clientSecret: () => env.CLIENT_SECRET,
    userInfoEndpoints: USER_INFO_ENDPOINTS,
  }),
});

/**
 * A verified delivery names an object, which is read again from WorkOS and
 * written as it is now, or removed if WorkOS answers 404, so deliveries can
 * arrive in any order. A domain the copy holds that an organization no
 * longer lists is read by id too, and removed only on a 404. A membership
 * delivery reads the directory user again, whose roles it may move. A failure
 * answers 500, and WorkOS retries.
 */
http.route({
  path: "/webhook",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    const endpoint = await ctx.runQuery(internal.webhook.read, {});
    if (endpoint === null) {
      return new Response("The webhook is not registered.", { status: 401 });
    }
    const body = await request.text();
    const verified = await verifyWebhookSignature({
      header: request.headers.get("WorkOS-Signature"),
      body,
      secret: endpoint.secret,
      now: Date.now(),
    });
    if (!verified) {
      return new Response("Invalid signature.", { status: 401 });
    }
    let target;
    try {
      target = decodeEvent(JSON.parse(body));
    } catch {
      return new Response("Unreadable event.", { status: 400 });
    }
    if (target === null) return new Response(null, { status: 200 });
    const update = await read(target.kind, target.id);
    await ctx.runMutation(internal.reconcile.settle, {
      kind: target.kind,
      updates: update === null ? [] : [update],
      gone: update === null ? [target.id] : [],
    });
    if (update?.kind === "organization") {
      const listed = new Set(update.domains.map((domain) => domain.row.id));
      const held = await ctx.runQuery(api.organizationDomains.list, {
        organizationId: update.row.id,
      });
      const updates = [];
      const gone = [];
      for (const domain of held) {
        if (listed.has(domain.id)) continue;
        const now = await read("organizationDomain", domain.id);
        if (now === null) gone.push(domain.id);
        else updates.push(now);
      }
      await ctx.runMutation(internal.reconcile.settle, {
        kind: "organizationDomain",
        updates,
        gone,
      });
    }
    return new Response(null, { status: 200 });
  }),
});

export default http;
