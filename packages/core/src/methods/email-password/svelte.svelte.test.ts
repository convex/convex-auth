import { makeFunctionReference } from "convex/server";
import { setConvexClientContext } from "convex-svelte";
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import { createStore } from "../../browser/store.ts";
import {
  fakeConvexClient,
  mountHelper,
  watch,
} from "../../svelte/testing.svelte.fixture.ts";
import {
  useCompletePasswordRecovery,
  useCompleteSignUpWithEmailPassword,
} from "./svelte.ts";

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

describe("useCompletePasswordRecovery", () => {
  const recoveryApi = {
    checkPasswordRecovery: makeFunctionReference<"query">(
      "auth:checkPasswordRecovery",
    ),
    completePasswordRecovery: makeFunctionReference<"mutation">(
      "auth:completePasswordRecovery",
    ),
  } as never;
  const RECOVERY_SECRET_KEY = "__convexAuthEmailPasswordRecoverySecret";

  it("keeps its subscription to the check while the new password is submitted", async () => {
    const snapshot = createStore({
      isLoading: false,
      isAuthenticated: false,
      token: null as string | null,
    });
    const storage = new Map([[RECOVERY_SECRET_KEY, "browser-secret"]]);
    const authClient = {
      getSnapshot: snapshot.get,
      subscribe: snapshot.subscribe,
      setSession: vi.fn(async () => {}),
      methodStorage: {
        get: (key: string) => storage.get(key),
        set: (key: string, value: string) => void storage.set(key, value),
        remove: (key: string) => void storage.delete(key),
      },
    } as unknown as AuthClient;
    let finish: (result: unknown) => void = () => {};
    const signInApi = {
      mutation: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    } as unknown as AuthSignInApi;
    const convex = fakeConvexClient();

    const { result, destroy } = mountHelper({ authClient, signInApi }, () => {
      setConvexClientContext(convex.client);
      return useCompletePasswordRecovery(recoveryApi, { emailCode: "code" });
    });
    const states = watch(() => result.current.status);

    const checkArgs = { emailCode: "code", browserSecret: "browser-secret" };
    await vi.waitFor(() => {
      flushSync();
      expect(convex.subscriptions("auth:checkPasswordRecovery")).toHaveLength(
        1,
      );
    });
    convex.push("auth:checkPasswordRecovery", checkArgs, { success: true });
    flushSync();
    const ready = result.current;
    if (ready.status !== "ready") throw new Error(`state: ${ready.status}`);

    const submit = ready.completePasswordRecovery({ newPassword: "new-pw" });
    flushSync();
    expect(result.current).toMatchObject({ status: "ready", pending: true });
    // The mutation claims the link, which the subscription hears first.
    convex.push("auth:checkPasswordRecovery", checkArgs, {
      success: false,
      userError: { error: "INVALID_CODE" },
    });
    finish({ status: "complete", tokens });
    await submit;
    flushSync();

    expect(result.current).toEqual({ status: "complete" });
    expect(new Set(states.values)).toEqual(
      new Set(["loading", "ready", "complete"]),
    );
    // One subscription, kept across the changes of `pending` and the
    // outcome, which don't change the arguments of the check.
    expect(convex.onUpdate).toHaveBeenCalledTimes(1);
    expect(convex.unsubscribed()).toBe(0);
    states.stop();
    destroy();
  });
});
