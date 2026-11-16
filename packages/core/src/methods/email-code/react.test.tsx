// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { anyApi, makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { NamespacedStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import { useSignInWithEmailCode } from "./react.tsx";

// `signIn` runs its mutation through the injected `AuthSignInApi`, and
// `sendCode` through the Convex client. The tests stub both.
const { signInApi, run: runSignInMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";
const convexClient = new ConvexReactClient(NAMESPACE);
const stubConvexMutation = () => vi.spyOn(convexClient, "mutation");

const secretStorage = new NamespacedStorage(window.localStorage, NAMESPACE);
const SECRET_KEY = "__convexAuthEmailCodeSecret";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The hook reads the function names of its references, so it needs real
// ones. The stubs ignore them.
const api = {
  startSignInWithEmailCode: makeFunctionReference<"mutation">(
    "auth:startSignInWithEmailCode",
  ) as never,
  completeSignInWithEmailCode: makeFunctionReference<"mutation">(
    "auth:completeSignInWithEmailCode",
  ) as never,
};

function renderWithProviders() {
  const authClient = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: window.localStorage,
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <ConvexProvider client={convexClient}>
        <AuthProvider authClient={authClient} signInApi={signInApi}>
          {children}
        </AuthProvider>
      </ConvexProvider>
    </StrictMode>
  );
  return renderHook(
    () => ({ auth: useAuth(), hook: useSignInWithEmailCode(api) }),
    { wrapper },
  );
}

async function render() {
  const rendered = renderWithProviders();
  await waitFor(() =>
    expect(rendered.result.current.auth.isLoading).toBe(false),
  );
  return rendered;
}

// Vitest runs without `globals`, so Testing Library does not register its
// automatic cleanup. Unmount each tree here, before the next test starts.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  runSignInMutation.mockReset();
  window.localStorage.clear();
});

describe("useSignInWithEmailCode: sendCode", () => {
  test("stores the secret and keeps it out of the result", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.sendCode>>;
    await act(async () => {
      returned = await result.current.hook.sendCode({
        email: "alice@example.com",
      });
    });

    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      { email: "alice@example.com" },
      expect.anything(),
    );
    expect(returned).toEqual({ success: true });
    expect(await secretStorage.get(SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("returns a user error and stores nothing", async () => {
    const failure = {
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: 1000 },
    };
    stubConvexMutation().mockResolvedValue(failure);
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.sendCode>>;
    await act(async () => {
      returned = await result.current.hook.sendCode({
        email: "alice@example.com",
      });
    });

    expect(returned).toEqual(failure);
    expect(await secretStorage.get(SECRET_KEY)).toBeNull();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    stubConvexMutation().mockRejectedValue(cause);
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.sendCode>>;
    await act(async () => {
      returned = await result.current.hook.sendCode({
        email: "alice@example.com",
      });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });
});

describe("useSignInWithEmailCode: signIn", () => {
  test("sends the stored secret, adopts the session, and clears the secret", async () => {
    await secretStorage.set(SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "12345678" });
    });

    expect(runSignInMutation).toHaveBeenCalledWith({
      code: "12345678",
      browserSecret: "secret-1",
    });
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(await secretStorage.get(SECRET_KEY)).toBeNull();
  });

  test("a wrong code keeps the secret, thus the user can retry", async () => {
    await secretStorage.set(SECRET_KEY, "secret-1");
    const failure = { status: "error", userError: { error: "INCORRECT_CODE" } };
    runSignInMutation.mockResolvedValue(failure);
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "00000000" });
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(await secretStorage.get(SECRET_KEY)).toBe("secret-1");
  });

  test("without a stored secret, fails with MISSING_SECRET", async () => {
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "12345678" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "MISSING_SECRET" },
    });
    expect(runSignInMutation).not.toHaveBeenCalled();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    await secretStorage.set(SECRET_KEY, "secret-1");
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = await render();

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "12345678" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("the callbacks keep their identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is. It returns a new reference
    // object on each property access.
    const authClient = new AuthClient({
      mode: "spa",
      authApi: {
        refreshSession: async () => ({ kind: "noSession" as const }),
        signOut: async () => {},
      },
      storage: window.localStorage,
      storageNamespace: NAMESPACE,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ConvexProvider client={convexClient}>
        <AuthProvider authClient={authClient} signInApi={signInApi}>
          {children}
        </AuthProvider>
      </ConvexProvider>
    );
    const { result, rerender } = renderHook(
      () => ({
        auth: useAuth(),
        hook: useSignInWithEmailCode(anyApi.auth as never),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const { sendCode, signIn } = result.current.hook;

    rerender();

    expect(result.current.hook.signIn).toBe(signIn);
    expect(result.current.hook.sendCode).toBe(sendCode);
  });
});
