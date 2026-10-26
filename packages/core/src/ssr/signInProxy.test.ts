import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../lib/types.ts";
import { AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE } from "./cookies.ts";
import { convexProxyHandler, type ExposedSignInFn } from "./signInProxy.ts";

const CONVEX_URL = "https://happy-animal-123.convex.cloud";

const signIn = makeFunctionReference<"action">(
  "auth:signInWithUsernamePassword",
) as ExposedSignInFn;

function bundle(): TokenBundle {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    refreshTokenExpiresAt: 2_000,
    userId: "user-1",
  };
}

const handler = convexProxyHandler({
  convexUrl: CONVEX_URL,
  signIn: [signIn],
  cookieOptions: { secure: true },
});

/**
 * A request shaped the way `ConvexHttpClient` shapes one, with the endpoint in
 * the `path` parameter. Same-origin by default, since the CSRF guard refuses
 * anything else before the body is read.
 */
function call(
  body: unknown,
  opts: { kind?: string; headers?: Record<string, string> } = {},
) {
  return new Request(
    `https://app.test/auth/proxy?path=/api/${opts.kind ?? "action"}`,
    {
      method: "POST",
      headers: {
        origin: "https://app.test",
        host: "app.test",
        "content-type": "application/json",
        ...opts.headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

const envelope = (args: unknown = {}) => ({
  path: "auth:signInWithUsernamePassword",
  format: "convex_encoded_json",
  args: [args],
});

/** Stub the deployment's reply to a function call. */
function upstream(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const setCookies = (response: Response) =>
  response.headers.getSetCookie().join("\n");

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("token interception", () => {
  test("moves the refresh token into an httpOnly cookie and slims the body", async () => {
    upstream({
      status: "success",
      value: { status: "complete", tokens: bundle() },
    });

    const response = await handler(call(envelope()));
    expect(response.status).toBe(200);

    const body = await response.json();
    // The envelope survives; only the refresh half of the bundle is removed.
    expect(body.value.status).toBe("complete");
    expect(body.value.tokens).toEqual({
      accessToken: "access-1",
      userId: "user-1",
    });
    expect(JSON.stringify(body)).not.toContain("refresh-1");

    const cookies = setCookies(response);
    expect(cookies).toContain(`${AUTH_REFRESH_COOKIE}=refresh-1`);
    expect(cookies).toContain(`${AUTH_JWT_COOKIE}=access-1`);
    expect(cookies).toContain("HttpOnly");
  });

  test("keeps the fields a provider adds beside the bundle", async () => {
    // `finishSignIn` of the passkey provider returns the username alongside the
    // tokens. The refresh token is the only thing the proxy removes.
    upstream({
      status: "success",
      value: { status: "complete", tokens: bundle(), username: "alice" },
    });

    const body = await (await handler(call(envelope()))).json();
    expect(body.value.username).toBe("alice");
    expect(body.value.tokens.refreshToken).toBeUndefined();
  });

  test("passes a failure arm through untouched and writes no cookies", async () => {
    upstream({
      status: "success",
      value: { status: "error", userError: { error: "INVALID_CREDENTIALS" } },
    });

    const response = await handler(call(envelope()));
    const body = await response.json();
    expect(body.value).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
    // A failed sign-in is a successful call: the transport says 200 and the
    // application result carries the reason.
    expect(response.status).toBe(200);
    expect(setCookies(response)).toBe("");
  });

  test("refuses a challenge-minting function, which is why those bypass the proxy", async () => {
    // What `startSignIn` of the passkey provider returns. A provider must run
    // this one on the Convex client, not through the sign-in API: the proxy
    // classifies every reply as the sign-in envelope, and this is not one.
    upstream({
      status: "success",
      value: { success: true, step: "register", rpId: "app.test" },
    });

    const response = await handler(call(envelope()));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("did not return a sign-in result");
  });

  test("refuses a status this handler does not know", async () => {
    // A deployment running a provider newer than the handler serving it. The
    // arm may well carry no tokens, but the proxy does not guess: forwarding an
    // arm it cannot classify is how a refresh token reaches browser JS.
    upstream({
      status: "success",
      value: { status: "requires-second-factor", challenge: "abc" },
    });

    const response = await handler(call(envelope()));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("did not return a sign-in result");
    expect(setCookies(response)).toBe("");
  });

  test("fails closed when an exposed function returns an unrecognized shape", async () => {
    // The dangerous case: were this forwarded, a refresh token would reach JS.
    upstream({ status: "success", value: bundle() });

    const response = await handler(call(envelope()));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("did not return a sign-in result");
    expect(setCookies(response)).toBe("");
  });
});

describe("what the proxy refuses", () => {
  test("a function that is not allowlisted", async () => {
    const fetchSpy = upstream({ status: "success", value: null });
    const response = await handler(
      call({ ...envelope(), path: "auth:somethingElse" }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "not exposed through the auth proxy",
    );
    // Refused before the deployment is ever contacted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a cross-site request, before reading the body", async () => {
    const fetchSpy = upstream({ status: "success", value: null });
    const response = await handler(
      call(envelope(), { headers: { origin: "https://evil.test" } }),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an unknown args encoding", async () => {
    const fetchSpy = upstream({ status: "success", value: null });
    const response = await handler(
      call({ ...envelope(), format: "some_future_format" }),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a path that is not a function endpoint", async () => {
    const fetchSpy = upstream({ status: "success", value: null });
    const response = await handler(call(envelope(), { kind: "query_ts" }));
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a request that names no endpoint at all", async () => {
    const fetchSpy = upstream({ status: "success", value: null });
    const response = await handler(
      new Request("https://app.test/auth/proxy", {
        method: "POST",
        headers: { origin: "https://app.test", host: "app.test" },
        body: JSON.stringify(envelope()),
      }),
    );
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a malformed body", async () => {
    const fetchSpy = upstream({ status: "success", value: null });
    const response = await handler(call("not json"));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("forwarding", () => {
  test("forwards args in the caller's encoding, and the caller's auth header", async () => {
    const fetchSpy = upstream({
      status: "success",
      value: { status: "complete", tokens: bundle() },
    });

    await handler(
      call(envelope({ username: "alice", password: "hunter2" }), {
        headers: { authorization: "Bearer caller-token" },
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONVEX_URL}/api/action`);
    expect(JSON.parse(init.body as string)).toEqual({
      path: "auth:signInWithUsernamePassword",
      format: "convex_encoded_json",
      args: [{ username: "alice", password: "hunter2" }],
    });
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer caller-token",
    );
  });

  test("routes each endpoint to its counterpart on the deployment", async () => {
    const fetchSpy = upstream({
      status: "success",
      value: { status: "complete", tokens: bundle() },
    });
    await handler(call(envelope(), { kind: "mutation" }));
    expect(fetchSpy.mock.calls[0][0]).toBe(`${CONVEX_URL}/api/mutation`);
  });

  test("never forwards the browser's cookies to the deployment", async () => {
    const fetchSpy = upstream({
      status: "success",
      value: { status: "complete", tokens: bundle() },
    });
    await handler(
      call(envelope(), {
        headers: { cookie: `${AUTH_REFRESH_COOKIE}=refresh-0` },
      }),
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(
      Object.keys(init.headers as object).map((h) => h.toLowerCase()),
    ).not.toContain("cookie");
  });

  test("forwards server log lines so a proxied call logs like a direct one", async () => {
    upstream({
      status: "success",
      value: { status: "complete", tokens: bundle() },
      logLines: ["from the function's console.log"],
    });
    const body = await (await handler(call(envelope()))).json();
    // The browser's ConvexHttpClient prints these, exactly as it would when
    // calling the same public function directly.
    expect(body.logLines).toEqual(["from the function's console.log"]);
  });

  test("passes a thrown function's error through so the client rethrows it", async () => {
    upstream(
      {
        status: "error",
        errorMessage: "rate limited",
        errorData: { code: "RATE_LIMITED" },
      },
      560,
    );
    const response = await handler(call(envelope()));
    // 560 is the status the client recognizes as "ran and threw"; any other
    // non-ok status would make it throw the raw body instead.
    expect(response.status).toBe(560);
    expect(await response.json()).toMatchObject({
      status: "error",
      errorData: { code: "RATE_LIMITED" },
    });
  });

  test("forwards a transport-level failure as-is", async () => {
    upstream({ nope: true }, 502);
    const response = await handler(call(envelope()));
    expect(response.status).toBe(502);
  });
});

describe("ConvexHttpClient wire contract", () => {
  // The proxy is implemented against details of how ConvexHttpClient talks to a
  // deployment that are not part of convex's public API surface. If a convex
  // bump changes any of them, this fails here rather than silently in an app.
  test("a real client's request is one the proxy understands, and its reply parses", async () => {
    const client = new ConvexHttpClient("/auth/proxy?path=", {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
    });

    // Stand in for the browser: let the real client build the request, run it
    // through the proxy, and hand the proxy's response back to the client.
    let posted: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/auth")) {
        posted = url;
        // The client posts a relative URL; give it an origin the guard accepts.
        return handler(
          new Request(`https://app.test${url}`, {
            method: "POST",
            headers: {
              ...(init?.headers as Record<string, string>),
              origin: "https://app.test",
              host: "app.test",
            },
            body: init?.body as string,
          }),
        );
      }
      // The proxy's own call to the deployment.
      return new Response(
        JSON.stringify({
          status: "success",
          value: { status: "complete", tokens: bundle() },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await client.action(
      makeFunctionReference<"action", { username: string }, unknown>(
        "auth:signInWithUsernamePassword",
      ),
      { username: "alice" },
    );

    // The endpoint went into the query string, leaving the mount point static:
    // this is what lets an app mount the handler without a catch-all route.
    expect(posted).toBe("/auth/proxy?path=/api/action");

    // The client parsed the proxy's reply, and the refresh token is gone.
    expect(result).toEqual({
      status: "complete",
      tokens: {
        accessToken: "access-1",
        userId: "user-1",
      },
    });
  });

  test("a thrown function surfaces to a real client as an error", async () => {
    const client = new ConvexHttpClient("/auth/proxy?path=", {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/auth")) {
        return handler(
          new Request(`https://app.test${url}`, {
            method: "POST",
            headers: {
              ...(init?.headers as Record<string, string>),
              origin: "https://app.test",
              host: "app.test",
            },
            body: init?.body as string,
          }),
        );
      }
      return new Response(
        JSON.stringify({ status: "error", errorMessage: "boom" }),
        { status: 560, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      client.action(
        makeFunctionReference<"action", Record<string, never>, unknown>(
          "auth:signInWithUsernamePassword",
        ),
        {},
      ),
    ).rejects.toThrow("boom");
  });
});
