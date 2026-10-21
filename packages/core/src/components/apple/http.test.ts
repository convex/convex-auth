import { convexTest } from "convex-test";
import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
} from "jose";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { testCallbackMethods } from "../../lib/oauth/componentContract.test.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";

const modules = import.meta.glob("./**/*.ts");

const CLIENT_ID = "com.example.app.web";
const TEAM_ID = "DEF123GHIJ";
const KEY_ID = "ABC123DEFG";
const REDIRECT_TO = "https://app.example.com/after";
const TOKEN_ENDPOINT = "https://appleid.apple.com/auth/token";

/** A real key, so the client secret the handler signs can be decoded. */
let privateKey: string;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey);
});

/**
 * The component instance binds Apple's credentials. convex-test emulates
 * neither component env bindings nor the backend applying `httpPrefix` to
 * `CONVEX_SITE_URL`, so both are stubbed the way the backend would present
 * them.
 */
function setup() {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("TEAM_ID", TEAM_ID);
  vi.stubEnv("KEY_ID", KEY_ID);
  vi.stubEnv("PRIVATE_KEY", privateKey);
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/apple");
  return convexTest(schema, modules);
}

/** One recorded outbound request made by the callback handler. */
type FetchCall = { url: string; init: RequestInit };

/**
 * Stub global `fetch` with an exact-URL routing table. `t.fetch` dispatches
 * to the component's router directly without touching global `fetch`, so the
 * stub only ever sees the handler's outbound token request.
 */
function stubFetch(
  routes: Record<string, (init: RequestInit) => Response | Promise<Response>>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const responder = routes[url];
      if (responder === undefined) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls.push({ url, init: init ?? {} });
      return await responder(init ?? {});
    }),
  );
  return calls;
}

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A structurally valid id_token with an unverifiable signature. The callback
 * deliberately skips signature verification (the token arrives from Apple's
 * token endpoint over TLS), so this exercises every claim check.
 */
function idToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    iss: "https://appleid.apple.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "001234.abcdef.0123",
    email: "ada@privaterelay.appleid.com",
    email_verified: "true",
    ...overrides,
  };
  return `${base64UrlEncode(JSON.stringify({ alg: "RS256" }))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}.signature`;
}

/** Apple's token endpoint answering a code exchange. */
function tokenRoute(claims: Record<string, unknown> = {}) {
  return {
    [TOKEN_ENDPOINT]: () =>
      new Response(JSON.stringify({ id_token: idToken(claims) }), {
        status: 200,
      }),
  };
}

/**
 * Record an authorization request the way `startSignInWithApple` would,
 * returning the raw `state` Apple echoes back to the callback.
 */
async function startFlow(t: ReturnType<typeof setup>): Promise<string> {
  const state = "state-raw-1";
  await t.mutation(api.provider.createAuthorizationRequest, {
    stateHash: await sha256Hex(state),
    redirectTo: REDIRECT_TO,
    codeVerifier: "verifier-1",
  });
  return state;
}

/** POST the callback the way Apple's `response_mode=form_post` does. */
function callback(
  t: ReturnType<typeof setup>,
  fields: Record<string, string>,
): Promise<Response> {
  return t.fetch("/callback", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * Assert `response` is a 303 back to the app and return the Location's params.
 * A POST callback needs 303 specifically: it is what turns the browser's
 * method back into GET for the app.
 */
function redirectParams(response: Response): URLSearchParams {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("Location")!);
  expect(`${location.origin}${location.pathname}`).toBe(
    "https://app.example.com/after",
  );
  return location.searchParams;
}

/** Redeem the minted ticket the way `completeSignInWithApple` would. */
async function redeem(
  t: ReturnType<typeof setup>,
  code: string,
  state: string,
): Promise<Record<string, unknown>> {
  const ticket = await t.mutation(api.provider.claimTicket, {
    ticketCodeHash: await sha256Hex(code),
    stateHash: await sha256Hex(state),
  });
  expect(ticket).not.toBeNull();
  return JSON.parse(
    await decryptTicketPayload(code, ticket!.encryptedPayload),
  ) as Record<string, unknown>;
}

function spyConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apple callback", () => {
  test("a posted callback exchanges the code and mints a redeemable ticket", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute());

    const params = redirectParams(
      await callback(t, { state, code: "apple-code-1" }),
    );
    const code = params.get(OAUTH_CODE_PARAM);
    expect(code).not.toBeNull();
    expect(params.get(OAUTH_ERROR_PARAM)).toBeNull();

    const payload = await redeem(t, code!, state);
    expect(payload.claims).toMatchObject({
      sub: "001234.abcdef.0123",
      email: "ada@privaterelay.appleid.com",
    });
  });

  test("the exchange presents a client secret signed the way Apple requires", async () => {
    const t = setup();
    const state = await startFlow(t);
    const calls = stubFetch(tokenRoute());

    await callback(t, { state, code: "apple-code-1" });

    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("apple-code-1");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("redirect_uri")).toBe(
      "https://test.convex.site/oauth/apple/callback",
    );
    expect(body.get("code_verifier")).toBe("verifier-1");

    const secret = body.get("client_secret")!;
    expect(decodeProtectedHeader(secret)).toEqual({
      alg: "ES256",
      kid: KEY_ID,
      typ: "JWT",
    });
    expect(decodeJwt(secret)).toMatchObject({
      iss: TEAM_ID,
      sub: CLIENT_ID,
      aud: "https://appleid.apple.com",
    });
  });

  test("a first authorization carries the sanitized name into the payload", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute());

    const params = redirectParams(
      await callback(t, {
        state,
        code: "apple-code-1",
        user: JSON.stringify({
          name: { firstName: "Ada", lastName: "Lovelace" },
          email: "attacker@example.com",
        }),
      }),
    );

    const payload = await redeem(t, params.get(OAUTH_CODE_PARAM)!, state);
    expect(payload.callbackParams).toEqual({
      user: { name: { firstName: "Ada", lastName: "Lovelace" } },
    });
  });

  test("a forged or oversized name is dropped rather than stored", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute());

    const params = redirectParams(
      await callback(t, {
        state,
        code: "apple-code-1",
        user: JSON.stringify({
          name: { firstName: "a".repeat(5000) },
          email: "attacker@example.com",
        }),
      }),
    );

    const payload = await redeem(t, params.get(OAUTH_CODE_PARAM)!, state);
    expect(payload.callbackParams).toBeUndefined();
  });

  test("a callback without a user field puts no callback params in the payload", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute());

    const params = redirectParams(
      await callback(t, { state, code: "apple-code-1" }),
    );
    const payload = await redeem(t, params.get(OAUTH_CODE_PARAM)!, state);
    expect(payload.callbackParams).toBeUndefined();
  });

  test("a cancelled sign-in comes back as access_denied", async () => {
    const t = setup();
    const state = await startFlow(t);
    const errors = spyConsoleError();
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});

    const params = redirectParams(
      await callback(t, { state, error: "user_cancelled_authorize" }),
    );
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("access_denied");
    expect(params.get(OAUTH_CODE_PARAM)).toBeNull();
    // A cancel is logged, but not as an error.
    expect(infos).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  test("an id_token from another issuer is refused", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute({ iss: "https://evil.example.com" }));
    spyConsoleError();

    const params = redirectParams(
      await callback(t, { state, code: "apple-code-1" }),
    );
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
  });

  test("an id_token for another audience is refused", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute({ aud: "com.someone.else" }));
    spyConsoleError();

    const params = redirectParams(
      await callback(t, { state, code: "apple-code-1" }),
    );
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
  });

  test("a callback without state gets a bare 400", async () => {
    const t = setup();
    const response = await callback(t, { code: "apple-code-1" });
    expect(response.status).toBe(400);
  });

  test("a replayed callback finds nothing left to claim", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch(tokenRoute());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    redirectParams(await callback(t, { state, code: "apple-code-1" }));
    const replay = await callback(t, { state, code: "apple-code-1" });
    expect(replay.status).toBe(400);
  });
});

// Apple posts the callback as a form, so POST is the only method it ever
// arrives over.
testCallbackMethods(schema, modules, ["POST"]);
