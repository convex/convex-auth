import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { testCallbackMethods } from "../../lib/oauth/componentContract.fixture.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";

/**
 * These tests cover the Google-specific constants. Everything the callback
 * shares with the other providers is covered by the custom-provider
 * component's suite (`../component/http.test.ts`), which exercises the same
 * code.
 */
const modules = import.meta.glob("./**/*.ts");

const CLIENT_ID = "test-client-id";
const REDIRECT_TO = "https://app.example.com/after";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUER = "https://accounts.google.com";

function setup() {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/google");
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

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A structurally valid id_token with an unverifiable signature. The callback
 * deliberately skips signature verification (the token arrives from Google's
 * token endpoint over TLS), so this exercises every claim check.
 */
function idToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "google-sub-1",
    email: "ada@example.com",
    email_verified: true,
    ...overrides,
  };
  return `${base64UrlEncode(JSON.stringify({ alg: "RS256" }))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}.signature`;
}

function tokenRoute(claims: Record<string, unknown> = {}) {
  return {
    [TOKEN_ENDPOINT]: () =>
      new Response(JSON.stringify({ id_token: idToken(claims) }), {
        status: 200,
      }),
  };
}

async function startFlow(t: ReturnType<typeof setup>): Promise<string> {
  const state = "state-raw-1";
  await t.mutation(
    api.provider._internal_dangerous_createAuthorizationRequest,
    {
      stateHash: await sha256Hex(state),
      redirectTo: REDIRECT_TO,
      codeVerifier: "verifier-1",
    },
  );
  return state;
}

function callback(
  t: ReturnType<typeof setup>,
  params: Record<string, string>,
): Promise<Response> {
  return t.fetch(`/callback?${new URLSearchParams(params)}`);
}

function redirectParams(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_TO);
  return location.searchParams;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("google callback", () => {
  test("exchanges the code and mints a ticket", async () => {
    const t = setup();
    const state = await startFlow(t);
    const calls = stubFetch(tokenRoute());

    const params = redirectParams(await callback(t, { state, code: "code-1" }));
    const code = params.get(OAUTH_CODE_PARAM);
    expect(code).not.toBeNull();

    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(calls[0]!.url).toBe(TOKEN_ENDPOINT);
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe(
      "https://test.convex.site/oauth/google/callback",
    );

    const ticket = await t.mutation(api.provider.claimTicket, {
      ticketCodeHash: await sha256Hex(code!),
      stateHash: await sha256Hex(state),
    });
    const payload = JSON.parse(
      await decryptTicketPayload(code!, ticket!.encryptedPayload),
    ) as { claims: { sub: string } };
    expect(payload.claims.sub).toBe("google-sub-1");
  });

  test("accepts the issuer spelled without the https prefix", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute({ iss: "accounts.google.com" }));

    const params = redirectParams(await callback(t, { state, code: "code-1" }));
    expect(params.get(OAUTH_CODE_PARAM)).not.toBeNull();
  });

  test("refuses an id_token from another issuer", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute({ iss: "https://evil.example.com" }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const params = redirectParams(await callback(t, { state, code: "code-1" }));
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
  });

  test("passes a declined sign-in back as access_denied", async () => {
    const t = setup();
    const state = await startFlow(t);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const params = redirectParams(
      await callback(t, { state, error: "access_denied" }),
    );
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("access_denied");
  });
});

testCallbackMethods(schema, modules);
