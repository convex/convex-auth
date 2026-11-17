import { makeFunctionReference } from "convex/server";
import { setConvexClientContext } from "convex-svelte";
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { AuthSignInApi } from "../browser/ambientSignInClient.ts";
import type { AuthClient } from "../browser/sessionManager.ts";
import { createStore } from "../browser/store.ts";
import { bindAuthClient, useAuthToken } from "./client.svelte.ts";
import {
  fakeConvexClient,
  mountHelper,
  watch,
} from "./testing.svelte.fixture.ts";

/** An unsigned JWT of the session `sub`, which expires at `exp`. */
function jwt(sub: string, exp = 2_000_000_000) {
  const part = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${part({ alg: "none" })}.${part({ sub, exp })}.sig`;
}

const signedIn = (token: string) => ({
  isLoading: false,
  isAuthenticated: true,
  token,
});

/** A stand-in for the `AuthClient`, whose snapshot the test sets. */
function fakeAuthClient() {
  const snapshot = createStore<{
    isLoading: boolean;
    isAuthenticated: boolean;
    token: string | null;
  }>({ isLoading: true, isAuthenticated: false, token: null });
  const authClient = {
    getSnapshot: snapshot.get,
    subscribe: snapshot.subscribe,
    init: vi.fn(async () => {}),
    dispose: vi.fn(),
    fetchAccessToken: vi.fn(async () => snapshot.get().token),
    setSession: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
  return {
    snapshot,
    authClient: authClient as unknown as AuthClient,
    mocks: authClient,
  };
}

const isAuthenticated = makeFunctionReference<"query">(
  "auth:isAuthenticated",
) as never;

/** Mount a component that binds a fake `AuthClient` to a fake Convex client. */
function mountBinding() {
  const { snapshot, authClient, mocks } = fakeAuthClient();
  const convex = fakeConvexClient();
  const { destroy } = mountHelper(undefined, () => {
    setConvexClientContext(convex.client);
    bindAuthClient({
      authClient,
      convex: convex.client,
      signInApi: {} as AuthSignInApi,
      isAuthenticated,
    });
  });
  return { snapshot, mocks, convex, destroy };
}

describe("bindAuthClient", () => {
  it("gives the Convex client a new token fetcher when the session changes, and only then", async () => {
    const { snapshot, mocks, convex, destroy } = mountBinding();
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(convex.setAuth).not.toHaveBeenCalled();

    snapshot.set(signedIn(jwt("session-1")));
    flushSync();
    expect(convex.setAuth).toHaveBeenCalledTimes(1);
    const firstFetcher = convex.setAuth.mock.calls[0][0];

    // A token refresh keeps the session.
    snapshot.set(signedIn(jwt("session-1", 2_000_000_100)));
    flushSync();
    expect(convex.setAuth).toHaveBeenCalledTimes(1);

    // Another tab signed in as someone else.
    snapshot.set(signedIn(jwt("session-2")));
    flushSync();
    const lastFetcher = convex.setAuth.mock.lastCall![0];
    expect(lastFetcher).not.toBe(firstFetcher);
    await expect(lastFetcher({ forceRefreshToken: false })).resolves.toBe(
      jwt("session-2"),
    );
    expect(mocks.fetchAccessToken).toHaveBeenCalledWith({
      forceRefreshToken: false,
    });

    destroy();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("signs out when the backend reports the session revoked", () => {
    const { snapshot, mocks, convex, destroy } = mountBinding();
    snapshot.set(signedIn(jwt("session-1")));
    flushSync();
    // The backend accepts the token.
    const onAuthChange = convex.setAuth.mock.lastCall![1]!;
    onAuthChange(true);
    flushSync();
    expect(convex.subscriptions("auth:isAuthenticated")).toHaveLength(1);

    convex.push("auth:isAuthenticated", {}, true);
    flushSync();
    expect(mocks.signOut).not.toHaveBeenCalled();

    // The session was revoked on the server.
    convex.push("auth:isAuthenticated", {}, false);
    flushSync();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    destroy();
  });
});

describe("useAuthToken", () => {
  it("follows the token of the client", () => {
    const { snapshot, authClient } = fakeAuthClient();
    const { result, destroy } = mountHelper({ authClient }, () =>
      useAuthToken(),
    );
    const tokens = watch(() => result.current);

    snapshot.set(signedIn("token-1"));
    flushSync();
    snapshot.set(signedIn("token-2"));
    flushSync();
    snapshot.set({ isLoading: false, isAuthenticated: false, token: null });
    flushSync();

    expect(tokens.values).toEqual([null, "token-1", "token-2", null]);
    tokens.stop();
    destroy();
  });
});
