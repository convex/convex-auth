import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { testCallbackMethods } from "../../lib/oauth/componentContract.test.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";

/**
 * These tests cover WorkOS's token exchange, its profile request and its
 * webhook. Everything the callback shares with the other methods is covered
 * by the custom OAuth component's suite.
 */
const modules = import.meta.glob("./**/*.ts");

const REDIRECT_TO = "https://app.example.com/after";
const TOKEN_ENDPOINT = "https://api.workos.com/sso/token";
const PROFILE_ENDPOINT = "https://api.workos.com/sso/profile";
const WEBHOOK_SECRET = "webhook-secret";

function setup(env: Record<string, string> = {}) {
  vi.stubEnv("CLIENT_ID", "client_1");
  vi.stubEnv("CLIENT_SECRET", "sk_test_1");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/workos");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return convexTest(schema, modules);
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  routes: Record<string, (init: RequestInit) => Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const responder = routes[url];
      if (responder === undefined) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls.push({ url, init: init ?? {} });
      return responder(init ?? {});
    }),
  );
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const PROFILE = {
  object: "profile",
  id: "prof_1",
  idp_id: "00u1",
  organization_id: "org_1",
  connection_id: "conn_1",
  connection_type: "OktaSAML",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
};

function workosRoutes() {
  return {
    [TOKEN_ENDPOINT]: () =>
      jsonResponse({
        token_type: "Bearer",
        access_token: "access-1",
        expires_in: 600,
        profile: PROFILE,
      }),
    [PROFILE_ENDPOINT]: () => jsonResponse(PROFILE),
  };
}

async function startFlow(t: ReturnType<typeof setup>): Promise<string> {
  const state = "state-raw-1";
  await t.mutation(api.provider.createAuthorizationRequest, {
    stateHash: await sha256Hex(state),
    redirectTo: REDIRECT_TO,
    codeVerifier: "verifier-1",
  });
  return state;
}

function redirectParams(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_TO);
  return location.searchParams;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workos callback", () => {
  test("exchanges the code with the API key and mints a ticket from the profile", async () => {
    const t = setup();
    const state = await startFlow(t);
    const calls = stubFetch(workosRoutes());
    const params = redirectParams(
      await t.fetch(
        `/callback?${new URLSearchParams({ state, code: "code-1" })}`,
      ),
    );
    const code = params.get(OAUTH_CODE_PARAM);
    expect(code).not.toBeNull();

    const exchange = calls.find((call) => call.url === TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(exchange?.init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("client_1");
    expect(body.get("client_secret")).toBe("sk_test_1");
    expect(body.get("code")).toBe("code-1");

    const profileCall = calls.find((call) => call.url === PROFILE_ENDPOINT);
    expect(new Headers(profileCall?.init.headers).get("Authorization")).toBe(
      "Bearer access-1",
    );

    const ticket = await t.mutation(api.provider.claimTicket, {
      ticketCodeHash: await sha256Hex(code ?? ""),
      stateHash: await sha256Hex(state),
    });
    const payload: unknown = JSON.parse(
      await decryptTicketPayload(code ?? "", ticket?.encryptedPayload ?? ""),
    );
    expect(payload).toMatchObject({ userInfoResponses: { profile: PROFILE } });
  });

  test("a refused exchange redirects back with oauth_error", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch({
      ...workosRoutes(),
      [TOKEN_ENDPOINT]: () => jsonResponse({ error: "invalid_grant" }, 400),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const params = redirectParams(
      await t.fetch(
        `/callback?${new URLSearchParams({ state, code: "code-1" })}`,
      ),
    );
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
  });
});

testCallbackMethods(schema, modules);

async function sign(body: string, timestamp: number, secret = WEBHOOK_SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `t=${timestamp}, v1=${hex}`;
}

describe("workos webhook", () => {
  const body = JSON.stringify({ id: "event_1", event: "user.created" });

  async function register(t: ReturnType<typeof setup>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("webhook", {
        endpointId: "we_1",
        url: "https://test.convex.site/workos/webhook",
        secret: WEBHOOK_SECRET,
        onEvent: "function://handler",
      });
    });
  }

  test("answers a signed delivery it does not keep with 200", async () => {
    const t = setup();
    await register(t);
    const response = await t.fetch("/webhook", {
      method: "POST",
      headers: { "WorkOS-Signature": await sign(body, Date.now()) },
      body,
    });
    expect(response.status).toBe(200);
  });

  test("answers an unreadable signed delivery with 400", async () => {
    const t = setup();
    await register(t);
    const garbled = JSON.stringify({ event: "dsync.user.updated", data: 1 });
    const response = await t.fetch("/webhook", {
      method: "POST",
      headers: { "WorkOS-Signature": await sign(garbled, Date.now()) },
      body: garbled,
    });
    expect(response.status).toBe(400);
  });

  test.each([
    ["no signature", async () => undefined],
    ["a wrong secret", async () => await sign(body, Date.now(), "other")],
    [
      "a stale timestamp",
      async () => await sign(body, Date.now() - 10 * 60 * 1000),
    ],
  ])("refuses a delivery with %s", async (_name, signature) => {
    const t = setup();
    await register(t);
    const header = await signature();
    const response = await t.fetch("/webhook", {
      method: "POST",
      headers: header === undefined ? {} : { "WorkOS-Signature": header },
      body,
    });
    expect(response.status).toBe(401);
  });

  test("refuses a signed delivery before the endpoint is registered", async () => {
    const t = setup();
    const response = await t.fetch("/webhook", {
      method: "POST",
      headers: { "WorkOS-Signature": await sign(body, Date.now()) },
      body,
    });
    expect(response.status).toBe(401);
  });
});
