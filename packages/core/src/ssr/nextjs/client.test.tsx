// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SignInFunction } from "../../browser/signInApi.ts";
import { InMemoryStorage, JWT_STORAGE_KEY } from "../../browser/storage.ts";
import { useAuthToken } from "../../react/index.tsx";
import {
  ConvexAuthNextjsProvider,
  ConvexAuthNextjsServerStateProvider,
  createNextjsAuthClient,
} from "./client.tsx";

const URL = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

const signInRef = makeFunctionReference<"mutation">(
  "auth:signInProbe",
) as unknown as SignInFunction<"mutation">;

/** Stub `fetch` so every route answers with `body`. */
function stubFetch(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * A real Convex client with mocked auth calls, so it never opens a socket.
 */
function makeConvexClient() {
  const client = new ConvexReactClient(URL);
  vi.spyOn(client, "setAuth").mockImplementation(() => {});
  vi.spyOn(client, "clearAuth").mockImplementation(() => {});
  return client;
}

describe("createNextjsAuthClient", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("sign-in functions go to the auth proxy with the current access token", async () => {
    const fetchMock = stubFetch({
      status: "success",
      value: "ok",
      logLines: [],
    });
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const auth = createNextjsAuthClient({
      convex: makeConvexClient(),
      storage,
    });
    await auth.init();

    await expect(auth.signIn.mutation(signInRef, {})).resolves.toBe("ok");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/auth/signin?path=/api/mutation");
    expect(JSON.parse(init.body as string)).toMatchObject({
      path: "auth:signInProbe",
    });
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer access-1",
    );
  });

  test("refresh and sign-out post to their routes", async () => {
    const fetchMock = stubFetch({ tokens: null });
    const auth = createNextjsAuthClient({
      convex: makeConvexClient(),
      refreshRoute: "/api/auth/refresh",
      signOutRoute: "/api/auth/signout",
      storage: new InMemoryStorage(),
    });
    await auth.init();

    await auth.fetchAccessToken({ forceRefreshToken: true });
    await auth.signOut();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/refresh",
      "/api/auth/signout",
    ]);
  });

  test("the provider stores the token from the server provider", async () => {
    const storage = new InMemoryStorage();
    const auth = createNextjsAuthClient({
      convex: makeConvexClient(),
      storage,
    });
    let token: string | null = null;
    function Probe() {
      token = useAuthToken();
      return null;
    }
    render(
      <ConvexAuthNextjsServerStateProvider initialToken="access-ssr">
        <ConvexAuthNextjsProvider auth={auth}>
          <Probe />
        </ConvexAuthNextjsProvider>
      </ConvexAuthNextjsServerStateProvider>,
    );

    await waitFor(() => expect(token).toBe("access-ssr"));
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-ssr");
  });
});
