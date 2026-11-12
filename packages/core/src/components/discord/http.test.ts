import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { testCallbackMethods } from "../../lib/oauth/componentContract.fixture.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";

/**
 * These tests cover the Discord-specific constants and the userinfo request.
 * Everything the callback shares with the other providers is covered by the
 * custom-provider component's suite (`../component/http.test.ts`), which
 * exercises the same code.
 */
const modules = import.meta.glob("./**/*.ts");

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_TO = "https://app.example.com/after";
const TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";
const USER_INFO_ENDPOINT = "https://discord.com/api/v10/users/@me";

function setup() {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/discord");
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

/** The token endpoint plus the userinfo endpoint, answering normally. */
function discordRoutes() {
  return {
    [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "access-1" }),
    [USER_INFO_ENDPOINT]: () =>
      jsonResponse({
        id: "80351110224678912",
        username: "nelly",
        discriminator: "0",
        global_name: "Nelly",
        avatar: null,
        email: "nelly@example.com",
        verified: true,
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

describe("discord callback", () => {
  test("fetches the user endpoint and mints a ticket from it", async () => {
    const t = setup();
    const state = await startFlow(t);
    const calls = stubFetch(discordRoutes());

    const params = redirectParams(await callback(t, { state, code: "code-1" }));
    const code = params.get(OAUTH_CODE_PARAM);
    expect(code).not.toBeNull();

    const tokenCall = calls.find((call) => call.url === TOKEN_ENDPOINT)!;
    expect(tokenCall.init.method).toBe("POST");
    const tokenBody = new URLSearchParams(String(tokenCall.init.body));
    expect(tokenBody.get("client_id")).toBe(CLIENT_ID);
    expect(tokenBody.get("client_secret")).toBe(CLIENT_SECRET);
    expect(tokenBody.get("code")).toBe("code-1");
    expect(tokenBody.get("code_verifier")).toBe("verifier-1");

    const userCall = calls.find((call) => call.url === USER_INFO_ENDPOINT)!;
    const headers = userCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-1");

    const ticket = await t.mutation(api.provider.claimTicket, {
      ticketCodeHash: await sha256Hex(code!),
      stateHash: await sha256Hex(state),
    });
    const payload = JSON.parse(
      await decryptTicketPayload(code!, ticket!.encryptedPayload),
    ) as { userInfoResponses: { user: { id: string; username: string } } };
    expect(payload.userInfoResponses.user.id).toBe("80351110224678912");
    expect(payload.userInfoResponses.user.username).toBe("nelly");
  });

  test("redirects with oauth_error when the user request fails", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch({
      ...discordRoutes(),
      [USER_INFO_ENDPOINT]: () =>
        jsonResponse({ message: "401: Unauthorized", code: 0 }, 401),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const params = redirectParams(await callback(t, { state, code: "code-1" }));
    expect(params.get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(params.get(OAUTH_CODE_PARAM)).toBeNull();
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
