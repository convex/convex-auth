import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OAUTH_ACTIONS_KEY } from "../methods/oauth/client.ts";
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

/**
 * Returns a `ConvexReactClient` with stubs for its `mutation` and `action`
 * methods.
 */
function stubConvex() {
  const convex = new ConvexReactClient(URL);
  const mutation = vi
    .spyOn(convex, "mutation")
    .mockResolvedValue("mutation-result" as never);
  const action = vi
    .spyOn(convex, "action")
    .mockResolvedValue("action-result" as never);
  return { convex, mutation, action };
}

/**
 * Stubs the global `fetch` with a mock that returns a given value as a Convex
 * HTTP response.
 */
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

  test("a refresh calls the refreshSession mutation over HTTP with the stored refresh token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const fetchMock = stubDeployment({ kind: "noSession" });
    const { convex, mutation } = stubConvex();
    const auth = createAuthClient({ convex, api: API, storage });
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

  test("sign-out calls the signOut mutation over HTTP and clears the session", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const fetchMock = stubDeployment(null);
    const { convex } = stubConvex();
    const auth = createAuthClient({ convex, api: API, storage });
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

  test("signInApi calls sign-in functions through the Convex client", async () => {
    const { convex, mutation, action } = stubConvex();
    const auth = createAuthClient({ convex, api: API });
    const signInMutation = makeFunctionReference<"mutation">("auth:signIn");
    const signInAction = makeFunctionReference<"action">("auth:signInAction");

    await expect(
      auth.signInApi.mutation(signInMutation as never, { code: "1" } as never),
    ).resolves.toBe("mutation-result");
    await expect(
      auth.signInApi.action(signInAction as never, { code: "2" } as never),
    ).resolves.toBe("action-result");

    expect(mutation).toHaveBeenCalledWith(signInMutation, { code: "1" });
    expect(action).toHaveBeenCalledWith(signInAction, { code: "2" });
  });

  test("registers the oauth ambient sign-in", () => {
    const auth = createAuthClient({ convex: stubConvex().convex, api: API });
    expect(
      auth.ambientSignInValues("oauth").get(OAUTH_ACTIONS_KEY),
    ).toBeDefined();
  });
});
