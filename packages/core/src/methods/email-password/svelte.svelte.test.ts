import { makeFunctionReference } from "convex/server";
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import { createStore } from "../../browser/store.ts";
import { mountHelper, watch } from "../../svelte/testing.svelte.fixture.ts";
import { useCompleteSignUpWithEmailPassword } from "./svelte.ts";

const api = {
  completeSignUpWithEmailPassword: makeFunctionReference<"mutation">(
    "auth:completeSignUpWithEmailPassword",
  ) as never,
};

const tokens = { accessToken: "access", refreshToken: "refresh" };
const SECRET_KEY = "__convexAuthEmailPasswordSignUpSecret";

describe("useCompleteSignUpWithEmailPassword", () => {
  it("presents the link once the session has loaded, and renders its state", async () => {
    const snapshot = createStore({
      isLoading: true,
      isAuthenticated: false,
      token: null as string | null,
    });
    const storage = new Map([[SECRET_KEY, "browser-secret"]]);
    const authClient = {
      getSnapshot: snapshot.get,
      subscribe: snapshot.subscribe,
      setSession: vi.fn(async () => {}),
      withSignInPending: <T>(fn: () => Promise<T>) => fn(),
      methodStorage: {
        get: (key: string) => storage.get(key),
        set: (key: string, value: string) => void storage.set(key, value),
        remove: (key: string) => void storage.delete(key),
      },
    } as unknown as AuthClient;
    const signInApi = {
      mutation: vi.fn(async () => ({ status: "complete", tokens })),
    } as unknown as AuthSignInApi;

    const { result, destroy } = mountHelper({ authClient, signInApi }, () =>
      useCompleteSignUpWithEmailPassword(api, { emailCode: "code" }),
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
      api.completeSignUpWithEmailPassword,
      { emailCode: "code", browserSecret: "browser-secret" },
    );
    expect(storage.has(SECRET_KEY)).toBe(false);
    expect(states.values).toEqual(["loading", "complete"]);
    states.stop();
    destroy();
  });
});
