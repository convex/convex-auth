import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { unusedConvex } from "../react/testSignInApi.ts";
import { createAuthClient } from "./createAuthClient.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage.ts";

const URL = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
};

/** Stub `fetch` so the deployment answers in the Convex HTTP format. */
function stubDeployment(value: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ status: "success", value, logLines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createAuthClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("refresh calls refreshSession over HTTP with the stored refresh token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const fetchMock = stubDeployment({ kind: "noSession" });
    const auth = createAuthClient({
      convex: unusedConvex,
      url: URL,
      api: API,
      storage,
    });
    await auth.init();

    await auth.fetchAccessToken({ forceRefreshToken: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${URL}/api/mutation`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      path: "auth:refreshSession",
      args: [{ refreshToken: "refresh-1" }],
    });
  });

  test("sign-out calls signOut over HTTP and clears the session", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const fetchMock = stubDeployment(null);
    const auth = createAuthClient({
      convex: unusedConvex,
      url: URL,
      api: API,
      storage,
    });
    await auth.init();

    await auth.signOut();

    expect(
      JSON.parse(fetchMock.mock.calls[0]![1].body as string),
    ).toMatchObject({
      path: "auth:signOut",
      args: [{ refreshToken: "refresh-1" }],
    });
    expect(auth.getSnapshot().isAuthenticated).toBe(false);
  });

  test("the url defaults to the Convex client's url, and the namespace to the url", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const convex = { ...unusedConvex, url: URL };
    const auth = createAuthClient({ convex, api: API, storage });
    await auth.init();
    expect(auth.getAccessToken()).toBe("access-1");
  });

  test("a Convex client with no url needs the url option", () => {
    expect(() =>
      createAuthClient({ convex: unusedConvex, api: API } as never),
    ).toThrow(/needs a url option/);
  });

  test("a url for another deployment than the Convex client's is rejected", () => {
    const convex = { ...unusedConvex, url: URL };
    expect(() =>
      createAuthClient({
        convex,
        url: "https://other-animal-456.convex.cloud",
        api: API,
      }),
    ).toThrow(/Build a new auth client for a different deployment/);
  });
});
