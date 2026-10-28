// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { AuthState } from "../../browser/sessionManager.ts";
import { InMemoryStorage, type TokenStorage } from "../../browser/storage.ts";
import {
  completeOauthSignIn,
  handleOauthCallback,
  startOauthSignIn,
} from "./client.ts";
import {
  acmeRefs,
  calledPath,
  completed,
  flowStorage,
  invalidCode,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  setupOAuth,
  stubReactNative,
} from "./testFlow.ts";

describe("OAuth client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("the flow error starts null", () => {
    const { flowError } = setupOAuth();
    expect(flowError()).toBeNull();
  });

  test("a callback code redeems and adopts the session", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(mutation).toHaveBeenCalledOnce();
    // The reference is rebuilt from the persisted function path.
    expect(calledPath(mutation)).toBe("auth:completeSignInAcme");
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(client.getSnapshot().token).toBe("access-1");
    expect(flowError()).toBeNull();
    // The one-time code is stripped from the URL.
    expect(window.location.search).toBe("");
  });

  test("stripping the callback params keeps the history state", async () => {
    // Routers (React Router) keep their own entry state in `history.state`.
    window.history.replaceState({ idx: 3 }, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ idx: 3 });
  });

  test("never reports signed out while a code is redeemed", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation } = setupOAuth({ storage });
    const { promise, resolve } = Promise.withResolvers<typeof completed>();
    mutation.mockReturnValueOnce(promise);

    // The session load finishes long before the redemption does. Any snapshot
    // in between that is done loading and not authenticated would bounce the
    // user to a sign-in screen.
    const signedOut: AuthState[] = [];
    const unsubscribe = client.subscribe(() => {
      const state = client.getSnapshot();
      if (!state.isLoading && !state.isAuthenticated) {
        signedOut.push(state);
      }
    });

    handleOauthCallback(client);
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve(completed);
    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(signedOut).toEqual([]);
    unsubscribe();
  });

  test("a second callback on the same URL finds it clean and no-ops", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client: first, mutation: firstMutation } = setupOAuth({ storage });
    firstMutation.mockResolvedValueOnce(completed);

    handleOauthCallback(first);
    await first.init();
    await vi.waitFor(() =>
      expect(first.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(window.location.search).toBe("");

    // The code is one-time, so a second client over the same page must not try
    // to redeem it again. Each harness makes its own mutation spy, so a second
    // redemption would show up on the second client's spy.
    const {
      client: second,
      mutation: secondMutation,
      flowError: secondFlowError,
    } = setupOAuth({ storage });
    handleOauthCallback(second);
    await second.init();

    expect(secondMutation).not.toHaveBeenCalled();
    // A code still in the URL with the flow already consumed would land here
    // as invalid_flow.
    expect(secondFlowError()).toBeNull();
  });

  test("a callback error param sets the flow error and strips the URL", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { client, mutation, flowError } = setupOAuth();

    handleOauthCallback(client);
    await client.init();

    expect(flowError()).toEqual({ error: "ACCESS_DENIED" });
    expect(mutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("a callback error consumes the pending flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, flowError } = setupOAuth({ storage });

    handleOauthCallback(client);
    await client.init();

    expect(flowError()?.error).toBe("ACCESS_DENIED");
    // The flow ended in an error, so the stored state can never complete.
    await vi.waitFor(() => expect(readFlow(storage)).toBeNull());
  });

  test("an expired error param sets EXPIRED", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=expired");
    const { client, flowError } = setupOAuth();

    handleOauthCallback(client);
    await client.init();

    expect(flowError()).toEqual({ error: "EXPIRED" });
  });

  test("an oauth_error param sets OTHER_ERROR with the param as cause", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=oauth_error");
    const { client, flowError } = setupOAuth();

    handleOauthCallback(client);
    await client.init();

    expect(flowError()).toEqual({ error: "OTHER_ERROR", cause: "oauth_error" });
  });

  test("an unknown error param sets OTHER_ERROR", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=server_exploded");
    const { client, flowError } = setupOAuth();

    handleOauthCallback(client);
    await client.init();

    expect(flowError()).toEqual({
      error: "OTHER_ERROR",
      cause: "server_exploded",
    });
  });

  test("a code without a pending flow sets INVALID_FLOW", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const { client, mutation, flowError } = setupOAuth();

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() => expect(flowError()?.error).toBe("INVALID_FLOW"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a pending flow without a completeSignIn path is invalid", async () => {
    // A record saved by an older client, or tampered with, that has no
    // function path. It must not crash or half-redeem.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    void flowStorage(storage).set(
      "flow",
      JSON.stringify({ providerName: "acme", state: "state-1" }),
    );
    const { client, mutation, flowError } = setupOAuth({ storage });

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() => expect(flowError()?.error).toBe("INVALID_FLOW"));
    expect(mutation).not.toHaveBeenCalled();
  });

  test("an INVALID_CODE error sets EXPIRED", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(invalidCode);

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() => expect(flowError()?.error).toBe("EXPIRED"));
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a failed redemption sets the flow error before loading ends", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(invalidCode);
    // The flow error at each change that leaves the client done loading. A
    // page reading both must never see signed out with no error to explain
    // it.
    const errorsOnceLoaded: unknown[] = [];
    client.subscribe(() => {
      if (!client.getSnapshot().isLoading) {
        errorsOnceLoaded.push(flowError());
      }
    });

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() => expect(flowError()?.error).toBe("EXPIRED"));
    expect(errorsOnceLoaded).not.toHaveLength(0);
    expect(errorsOnceLoaded).not.toContain(null);
  });

  test("a failed redemption sets OTHER_ERROR with the thrown error", async () => {
    // Also the dangling-path case: a persisted function path whose export was
    // renamed mid-flight fails the call the same way.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    const boom = new Error("boom");
    mutation.mockRejectedValueOnce(boom);

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() =>
      expect(flowError()).toEqual({ error: "OTHER_ERROR", cause: boom }),
    );
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("an app rejection sets REJECTED with the ConvexError data", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(
      new ConvexError("A verified email is required to sign in"),
    );

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() =>
      expect(flowError()).toEqual({
        error: "REJECTED",
        data: "A verified email is required to sign in",
      }),
    );
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("an app rejection passes non-string data through", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new ConvexError({ reason: "policy" }));

    handleOauthCallback(client);
    await client.init();

    // The app's backend chose the shape, so the app can read it.
    await vi.waitFor(() =>
      expect(flowError()).toEqual({
        error: "REJECTED",
        data: { reason: "policy" },
      }),
    );
  });

  test("a rejected storage read during redemption sets OTHER_ERROR", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    // Fail reads of the saved flow key, the way an async storage might. Reads
    // of the session tokens still work.
    const storage: TokenStorage = {
      getItem: (key) =>
        key.startsWith("__convexAuthProvider_oauth_flow")
          ? Promise.reject(new Error("storage broken"))
          : null,
      setItem: () => {},
      removeItem: () => {},
    };
    const { client, mutation, flowError } = setupOAuth({ storage });

    handleOauthCallback(client);
    await client.init();

    await vi.waitFor(() => expect(flowError()?.error).toBe("OTHER_ERROR"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("a rejected storage removal during error cleanup keeps the flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => Promise.reject(new Error("storage broken")),
    };
    const { client, flowError } = setupOAuth({ storage });

    handleOauthCallback(client);
    await client.init();

    expect(flowError()?.error).toBe("ACCESS_DENIED");
    // The cleanup is not awaited, so let the event loop run once for it to
    // finish. An unhandled rejection from it would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flowError()?.error).toBe("ACCESS_DENIED");
  });

  test("startOauthSignIn starts a flow, persists it, and returns the redirect", async () => {
    stubReactNative();
    const { mutation, convexMutation, client, storage } = setupOAuth();
    convexMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await startOauthSignIn(client, acmeRefs, {
      redirectTo: "http://localhost/app",
    });

    expect(convexMutation).toHaveBeenCalledExactlyOnceWith(
      acmeRefs.startSignIn,
      { redirectTo: "http://localhost/app" },
    );
    // Starting a flow mints no session, so it bypasses the sign-in api, which
    // under SSR is the auth proxy and refuses a non-envelope result.
    expect(mutation).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "redirect",
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The persisted flow has the completeSignIn function path, so
    // completion can run on a page that never held the references.
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("completeOauthSignIn completes the pending flow", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    const outcome = await completeOauthSignIn(client, "code-1");

    expect(outcome).toEqual({ status: "complete" });
    expect(mutation).toHaveBeenCalledOnce();
    expect(calledPath(mutation)).toBe("auth:completeSignInAcme");
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(client.getSnapshot().isAuthenticated).toBe(true);
  });

  test("completeOauthSignIn returns a failure rather than setting it", async () => {
    const { mutation, client, flowError } = setupOAuth();

    const outcome = await completeOauthSignIn(client, "code-1");

    expect(outcome).toEqual({
      status: "error",
      userError: { error: "INVALID_FLOW" },
    });
    expect(flowError()).toBeNull();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("startOauthSignIn clears a previous flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    stubReactNative();
    const { client, convexMutation, flowError } = setupOAuth();
    handleOauthCallback(client);
    await client.init();
    expect(flowError()?.error).toBe("ACCESS_DENIED");

    convexMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    });
    // React Native has no page URL to default to, so `redirectTo` is required.
    await startOauthSignIn(client, acmeRefs, {
      redirectTo: "http://localhost/app",
    });

    expect(flowError()).toBeNull();
  });

  test("a failed start resolves to OTHER_ERROR with the thrown error", async () => {
    const { convexMutation, client, flowError, storage } = setupOAuth();
    const boom = new Error("boom");
    convexMutation.mockRejectedValueOnce(boom);

    const outcome = await startOauthSignIn(client, acmeRefs);

    expect(outcome).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause: boom },
    });
    // The caller has the failure, so it isn't also the flow error.
    expect(flowError()).toBeNull();
    expect(flowStorage(storage).get("flow")).toBeNull();
  });

  test("a start that can't save the flow resolves to OTHER_ERROR", async () => {
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => Promise.reject(new Error("storage broken")),
      removeItem: () => {},
    };
    const { convexMutation, client, flowError } = setupOAuth({ storage });
    convexMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });

    const outcome = await startOauthSignIn(client, acmeRefs);

    expect(outcome).toMatchObject({
      status: "error",
      userError: { error: "OTHER_ERROR", cause: new Error("storage broken") },
    });
    expect(flowError()).toBeNull();
  });

  test("a ConvexError from the start is OTHER_ERROR too", async () => {
    // Starting runs no app code, so nothing there rejects a sign-in.
    const { convexMutation, client } = setupOAuth();
    const rejected = new ConvexError("Sign-ups are closed");
    convexMutation.mockRejectedValueOnce(rejected);

    const outcome = await startOauthSignIn(client, acmeRefs);

    expect(outcome).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause: rejected },
    });
  });

  test("a foreign code/error param is ignored and left in the URL", async () => {
    window.history.replaceState(null, "", "/?code=foreign&error=foreign");
    const { client, mutation, flowError } = setupOAuth();

    handleOauthCallback(client);
    await client.init();

    // Only namespaced params are ours. A plain code or error is the app's.
    expect(mutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });
});
