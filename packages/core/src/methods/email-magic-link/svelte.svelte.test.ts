import { makeFunctionReference } from "convex/server";
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import { createStore } from "../../browser/store.ts";
import { mountHelper, watch } from "../../svelte/testing.svelte.fixture.ts";
import {
  useSendEmailMagicLink,
  useSignInWithEmailMagicLink,
} from "./svelte.ts";

const api = {
  sendEmailMagicLink: makeFunctionReference<"mutation">(
    "auth:sendEmailMagicLink",
  ) as never,
  signInWithEmailMagicLink: makeFunctionReference<"mutation">(
    "auth:signInWithEmailMagicLink",
  ) as never,
};

const tokens = { accessToken: "access", refreshToken: "refresh" };
const SECRET_KEY = "__convexAuthEmailMagicLinkSecret";

/** An `AuthClient` stand-in whose session is still loading. */
function fakeAuthClient(storage: Map<string, string>) {
  const snapshot = createStore({
    isLoading: true,
    isAuthenticated: false,
    token: null as string | null,
  });
  const authClient = {
    getSnapshot: snapshot.get,
    subscribe: snapshot.subscribe,
    setSession: vi.fn(async () => {}),
    withSignInPending: <T>(fn: () => Promise<T>) => fn(),
    methodStorage: {
      get: (key: string) => storage.get(key) ?? null,
      set: (key: string, value: string) => void storage.set(key, value),
      remove: (key: string) => void storage.delete(key),
    },
  } as unknown as AuthClient;
  return { authClient, snapshot };
}

describe("useSendEmailMagicLink", () => {
  it("sends the link on the Convex client, keeps the secret, and tracks `pending`", async () => {
    const storage = new Map<string, string>();
    const { authClient } = fakeAuthClient(storage);
    const convex = {
      mutation: vi.fn(async () => ({
        success: true,
        browserSecret: "browser-secret",
      })),
    };
    const signInApi = { mutation: vi.fn() } as unknown as AuthSignInApi;
    const { result, destroy } = mountHelper(
      { authClient, signInApi, convex },
      () => useSendEmailMagicLink(api),
    );
    const pending = watch(() => result.pending);

    const sending = result.sendMagicLink({ email: "ada@example.com" });
    flushSync();
    expect(await sending).toEqual({ success: true });
    flushSync();

    expect(convex.mutation).toHaveBeenCalledWith(api.sendEmailMagicLink, {
      email: "ada@example.com",
    });
    expect(signInApi.mutation).not.toHaveBeenCalled();
    expect(storage.get(SECRET_KEY)).toBe("browser-secret");
    expect(pending.values).toEqual([false, true, false]);
    pending.stop();
    destroy();
  });
});

describe("useSignInWithEmailMagicLink", () => {
  it("presents the link once the session has loaded, and renders its state", async () => {
    const storage = new Map([[SECRET_KEY, "browser-secret"]]);
    const { authClient, snapshot } = fakeAuthClient(storage);
    const signInApi = {
      mutation: vi.fn(async () => ({ status: "complete", tokens })),
    } as unknown as AuthSignInApi;

    const { result, destroy } = mountHelper({ authClient, signInApi }, () =>
      useSignInWithEmailMagicLink(api, { emailCode: "code" }),
    );
    const states = watch(() => result.current.status);
    // Mounted, but the session is still loading.
    expect(signInApi.mutation).not.toHaveBeenCalled();

    snapshot.set({ isLoading: false, isAuthenticated: false, token: null });
    await vi.waitFor(() => expect(authClient.setSession).toHaveBeenCalled());
    await vi.waitFor(() => {
      flushSync();
      expect(result.current).toEqual({ status: "complete" });
    });

    expect(signInApi.mutation).toHaveBeenCalledWith(
      api.signInWithEmailMagicLink,
      { emailCode: "code", browserSecret: "browser-secret" },
    );
    expect(storage.has(SECRET_KEY)).toBe(false);
    expect(states.values).toEqual(["loading", "complete"]);
    states.stop();
    destroy();
  });

  it("throws in a component without the context of the bindings", () => {
    expect(() =>
      mountHelper(undefined, () =>
        useSignInWithEmailMagicLink(api, { emailCode: "code" }),
      ),
    ).toThrow(
      "useSignInWithEmailMagicLink() must be called in a component that calls setupConvexAuth()",
    );
  });
});
