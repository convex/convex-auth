import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { testCallbackMethods } from "../../lib/oauth/componentContract.test.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";

/**
 * These tests cover the GitHub-specific constants and the userinfo requests.
 * Everything the callback shares with the other providers is covered by the
 * custom-provider component's suite (`../component/http.test.ts`), which
 * exercises the same code.
 */
const modules = import.meta.glob("./**/*.ts");

const CLIENT_ID = "test-client-id";
const REDIRECT_TO = "https://app.example.com/after";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_INFO_ENDPOINTS = {
  user: "https://api.github.com/user",
  emails: "https://api.github.com/user/emails",
};

function setup() {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/github");
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The token endpoint plus both userinfo endpoints, answering normally. */
function githubRoutes() {
  return {
    [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "access-1" }),
    [USER_INFO_ENDPOINTS.user]: () =>
      jsonResponse({ id: 42, login: "octocat", avatar_url: "https://a/x.png" }),
    [USER_INFO_ENDPOINTS.emails]: () =>
      jsonResponse([
        { email: "octocat@example.com", primary: true, verified: true },
      ]),
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

describe("github callback", () => {
  test("fetches both userinfo endpoints and mints a ticket from them", async () => {
    const t = setup();
    const state = await startFlow(t);
    const calls = stubFetch(githubRoutes());

    const params = redirectParams(await callback(t, { state, code: "code-1" }));
    const code = params.get(OAUTH_CODE_PARAM);
    expect(code).not.toBeNull();

    const tokenCall = calls.find((call) => call.url === TOKEN_ENDPOINT)!;
    expect(
      new URLSearchParams(tokenCall.init.body as string).get("code_verifier"),
    ).toBe("verifier-1");

    for (const endpoint of Object.values(USER_INFO_ENDPOINTS)) {
      const call = calls.find((each) => each.url === endpoint)!;
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer access-1");
      // GitHub's API rejects requests without one.
      expect(headers["User-Agent"]).toBeDefined();
    }

    const ticket = await t.mutation(api.provider.claimTicket, {
      ticketCodeHash: await sha256Hex(code!),
      stateHash: await sha256Hex(state),
    });
    const payload = JSON.parse(
      await decryptTicketPayload(code!, ticket!.encryptedPayload),
    ) as { userInfoResponses: { user: { id: number }; emails: unknown[] } };
    expect(payload.userInfoResponses.user.id).toBe(42);
    expect(payload.userInfoResponses.emails).toHaveLength(1);
  });

  test("refuses a token response with no access_token", async () => {
    const t = setup();
    const state = await startFlow(t);
    stubFetch({
      ...githubRoutes(),
      [TOKEN_ENDPOINT]: () => jsonResponse({ token_type: "bearer" }),
    });
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
