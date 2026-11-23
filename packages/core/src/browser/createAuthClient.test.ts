import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OAUTH_ACTIONS_KEY } from "../methods/oauth/client.ts";
import type { ConvexClientApi } from "./convexClient.ts";
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
  isAuthenticated: makeFunctionReference<"query">("auth:isAuthenticated"),
};

/** A Convex client with no `url`, like a `ConvexClient`. */
function stubConvex() {
  const mutation = vi.fn(async () => "mutation-result");
  const action = vi.fn(async () => "action-result");
  const convex = { mutation, action } as unknown as ConvexClientApi;
  return { convex, mutation, action };
}

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
    const { convex, mutation } = stubConvex();
    const auth = createAuthClient({ convex, url: URL, api: API, storage });
    await auth.init();

    await auth.fetchAccessToken({ forceRefreshToken: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${URL}/api/mutation`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      path: "auth:refreshSession",
      args: [{ refreshToken: "refresh-1" }],
    });
    expect(mutation).not.toHaveBeenCalled();
  });

  test("sign-out calls signOut over HTTP and clears the session", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const fetchMock = stubDeployment(null);
    const { convex } = stubConvex();
    const auth = createAuthClient({ convex, url: URL, api: API, storage });
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

  test("sign-in functions are called through the Convex client", async () => {
    const { convex, mutation, action } = stubConvex();
    const auth = createAuthClient({ convex, url: URL, api: API });
    const signInMutation = makeFunctionReference<"mutation">("auth:signIn");
    const signInAction = makeFunctionReference<"action">("auth:signInAction");

    await expect(
      auth.signIn.mutation(signInMutation as never, { code: "1" } as never),
    ).resolves.toBe("mutation-result");
    await expect(
      auth.signIn.action(signInAction as never, { code: "2" } as never),
    ).resolves.toBe("action-result");

    expect(mutation).toHaveBeenCalledWith(signInMutation, { code: "1" });
    expect(action).toHaveBeenCalledWith(signInAction, { code: "2" });
  });

  test("the url defaults to the Convex client's url, and the namespace to the url", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const convex = { ...stubConvex().convex, url: URL };
    const auth = createAuthClient({ convex, api: API, storage });
    await auth.init();
    expect(auth.getAccessToken()).toBe("access-1");
  });

  test("a Convex client with no url needs the url option", () => {
    expect(() =>
      createAuthClient({ convex: stubConvex().convex, api: API } as never),
    ).toThrow(/needs a url option/);
  });

  test("oauth() is registered", () => {
    const auth = createAuthClient({
      convex: stubConvex().convex,
      url: URL,
      api: API,
    });
    expect(
      auth.ambientSignInValues("oauth").get(OAUTH_ACTIONS_KEY),
    ).toBeDefined();
  });
});
