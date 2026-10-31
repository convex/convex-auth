/**
 * The deployment's webhook endpoint at WorkOS: registering and unregistering
 * it, keeping the secret WorkOS signs its deliveries with, checking that
 * signature.
 *
 * @module
 */
import { v } from "convex/values";
import { internal } from "./_generated/api.ts";
import {
  action,
  env,
  internalMutation,
  internalQuery,
} from "./_generated/server.ts";
import { EVENTS } from "./constants.ts";
import { callWorkos, WorkosApiError } from "./rest.ts";
import { eventHandler } from "./mirror.ts";
import { decodeEndpoint, decodeList } from "./wire.ts";

/** How old a signed timestamp may be, against replays. */
const TOLERANCE_MS = 5 * 60 * 1000;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Compare in time independent of where the strings first differ. */
function equalInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Whether `header`, WorkOS's `WorkOS-Signature` header of the form
 * `t=<ms>, v1=<hex>`, signs `body` with `secret`: v1 is the HMAC-SHA256 of
 * `<t>.<body>`, and `t` must be recent.
 */
export async function verifyWebhookSignature(args: {
  header: string | null;
  body: string;
  secret: string;
  now: number;
}): Promise<boolean> {
  if (args.header === null) return false;
  const parts = new Map(
    args.header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")] as const;
    }),
  );
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (timestamp === undefined || signature === undefined) return false;
  const signedAt = Number(timestamp);
  if (
    !Number.isFinite(signedAt) ||
    Math.abs(args.now - signedAt) > TOLERANCE_MS
  ) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(args.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${args.body}`),
    ),
  );
  return equalInConstantTime(expected, signature.toLowerCase());
}

/** The most endpoints WorkOS lists on one page. */
const ENDPOINT_PAGE_SIZE = 100;

/**
 * Where WorkOS delivers this deployment's webhooks: the component's own
 * `/webhook` route. Inside a component, `CONVEX_SITE_URL` already ends with
 * the `httpPrefix` the app installed it under.
 */
function webhookUrl(): string {
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (siteUrl === undefined) {
    throw new Error(
      "CONVEX_SITE_URL is not visible inside the WorkOS component. " +
        "This requires a Convex backend with system env vars in component " +
        "functions.",
    );
  }
  return `${siteUrl}/webhook`;
}

/** Every endpoint of the WorkOS environment, a page at a time. */
async function* listEndpoints() {
  let after: string | undefined;
  do {
    const reply = await callWorkos(env.CLIENT_SECRET, {
      method: "GET",
      path: "/webhook_endpoints",
      query: { limit: String(ENDPOINT_PAGE_SIZE), after },
    });
    const page = decodeList(reply.body);
    for (const item of page.items) yield decodeEndpoint(item);
    after = page.after;
  } while (after !== undefined);
}

async function findEndpoint(url: string) {
  for await (const endpoint of listEndpoints()) {
    if (endpoint.url === url) return endpoint;
  }
  return null;
}

type Endpoint = ReturnType<typeof decodeEndpoint>;

async function createEndpoint(url: string): Promise<Endpoint> {
  const reply = await callWorkos(env.CLIENT_SECRET, {
    method: "POST",
    path: "/webhook_endpoints",
    body: { endpoint_url: url, events: [...EVENTS] },
  });
  return decodeEndpoint(reply.body);
}

/** The endpoint, enabled and subscribed to every event the copy applies. */
async function enableEndpoint(endpoint: Endpoint): Promise<Endpoint> {
  const missing = EVENTS.filter((event) => !endpoint.events.includes(event));
  if (endpoint.enabled && missing.length === 0) return endpoint;
  const reply = await callWorkos(env.CLIENT_SECRET, {
    method: "PATCH",
    path: `/webhook_endpoints/${encodeURIComponent(endpoint.id)}`,
    body: { status: "enabled", events: [...endpoint.events, ...missing] },
  });
  return decodeEndpoint(reply.body);
}

/**
 * Register this deployment's webhook endpoint at WorkOS, subscribed to the
 * events the copy applies, and keep its signing secret and the app's event
 * handler, a function handle to a mutation taking `{ event }`. Run it on
 * every deploy: it finds the endpoint by its URL, so it never creates a
 * second one, and it enables a disabled endpoint and subscribes it to any
 * event it is missing. Until it has run, the webhook refuses every delivery.
 */
export const register = action({
  args: { onEvent: v.string() },
  returns: v.object({ endpointId: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    eventHandler(args.onEvent);
    const url = webhookUrl();
    const found = await findEndpoint(url);
    const endpoint =
      found === null ? await createEndpoint(url) : await enableEndpoint(found);
    await ctx.runMutation(internal.webhook.keep, {
      endpointId: endpoint.id,
      url,
      secret: endpoint.secret,
      onEvent: args.onEvent,
    });
    return { endpointId: endpoint.id, created: found === null };
  },
});

/**
 * Delete this deployment's endpoint at WorkOS and forget its secret. Run it
 * before the deployment is deleted, so WorkOS stops delivering to it.
 * Returns whether there was an endpoint to delete.
 */
export const unregister = action({
  args: {},
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx) => {
    const kept = await ctx.runQuery(internal.webhook.read, {});
    const id = kept?.endpointId ?? (await findEndpoint(webhookUrl()))?.id;
    let deleted = false;
    if (id !== undefined) {
      try {
        await callWorkos(env.CLIENT_SECRET, {
          method: "DELETE",
          path: `/webhook_endpoints/${encodeURIComponent(id)}`,
        });
        deleted = true;
      } catch (error) {
        // Already deleted, e.g. in the dashboard.
        if (!(error instanceof WorkosApiError && error.status === 404)) {
          throw error;
        }
      }
    }
    await ctx.runMutation(internal.webhook.forget, {});
    return { deleted };
  },
});

export const keep = internalMutation({
  args: {
    endpointId: v.string(),
    url: v.string(),
    secret: v.string(),
    onEvent: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("webhook").first();
    if (row === null) await ctx.db.insert("webhook", args);
    else await ctx.db.replace("webhook", row._id, args);
    return null;
  },
});

export const forget = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await ctx.db.query("webhook").first();
    if (row !== null) await ctx.db.delete("webhook", row._id);
    return null;
  },
});

/** The registered endpoint, or null before `register` ran. */
export const read = internalQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ endpointId: v.string(), secret: v.string() }),
  ),
  handler: async (ctx) => {
    const row = await ctx.db.query("webhook").first();
    return row === null
      ? null
      : { endpointId: row.endpointId, secret: row.secret };
  },
});
