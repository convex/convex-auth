// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import {
  InMemoryStorage,
  NamespacedStorage,
  type TokenStorage,
} from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import {
  useSendEmailShortCode,
  useSignInWithEmailShortCode,
} from "./react.tsx";

// The hook that mints a session runs its mutation through the injected
// `AuthSignInApi`, so the test substitutes a signInApi rather than mocking
// `convex/react`.
const { signInApi, run: runSignInMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

// The hooks read the deployment URL from the surrounding ConvexProvider to
// namespace their secret storage, and the hook that does not mint a session
// runs its mutation through this client. The client never connects: the
// tests stub its `mutation` method.
const convexClient = new ConvexReactClient(NAMESPACE);
const stubConvexMutation = () => vi.spyOn(convexClient, "mutation");

// The hooks keep the secret in the storage passed to the auth provider,
// namespaced like the session tokens. Most tests pass `localStorage` (jsdom
// supplies one), as a browser app would.
const secretStorage = new NamespacedStorage(window.localStorage, NAMESPACE);
const SECRET_KEY = "__convexAuthEmailShortCodeSecret";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The hooks read the function name of the reference to keep their callbacks
// stable, so they need a real one. The stubs ignore it.
const signInMutation = makeFunctionReference<"mutation">(
  "auth:signIn",
) as never;
const sendMutation = makeFunctionReference<"mutation">("auth:send") as never;

function renderWithProviders<T>(
  useHook: () => T,
  storage: TokenStorage = window.localStorage,
) {
  const authClient = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage,
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
  return renderHook(() => ({ auth: useAuth(), hook: useHook() }), { wrapper });
}

// Vitest runs without `globals`, so Testing Library does not register its
// automatic cleanup. Unmount each tree here, before the next test starts.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  runSignInMutation.mockReset();
  window.localStorage.clear();
});

describe("useSendEmailShortCode", () => {
  const args = { email: "alice@example.com" };
  const render = () =>
    renderWithProviders(() =>
      useSendEmailShortCode({ sendEmailShortCode: sendMutation }),
    );

  test("success stores the secret and does not sign in", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.sendCode>>;
    await act(async () => {
      returned = await result.current.hook.sendCode(args);
    });

    // Sending the code mints no session, so it goes straight to Convex.
    expect(mutation.mock.calls[0]?.[1]).toEqual(args);
    expect(runSignInMutation).not.toHaveBeenCalled();
    // The secret stays out of the result: the hook keeps it for the code
    // step.
    expect(returned).toEqual({ success: true });
    expect(secretStorage.get(SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a second code replaces the secret of the first", async () => {
    stubConvexMutation()
      .mockResolvedValueOnce({ success: true, browserSecret: "secret-1" })
      .mockResolvedValueOnce({ success: true, browserSecret: "secret-2" });
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.hook.sendCode(args);
      await result.current.hook.sendCode(args);
    });
    expect(secretStorage.get(SECRET_KEY)).toBe("secret-2");
  });

  test("a user error stores nothing", async () => {
    const failure = {
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: 1000 },
    };
    stubConvexMutation().mockResolvedValue(failure);
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    let returned!: Awaited<ReturnType<typeof result.current.hook.sendCode>>;
    await act(async () => {
      returned = await result.current.hook.sendCode(args);
    });
    expect(returned).toEqual(failure);
    expect(secretStorage.get(SECRET_KEY)).toBeNull();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    stubConvexMutation().mockRejectedValue(cause);
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    let returned!: Awaited<ReturnType<typeof result.current.hook.sendCode>>;
    await act(async () => {
      returned = await result.current.hook.sendCode(args);
    });
    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("sendCode keeps its identity across rerenders", async () => {
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const before = result.current.hook.sendCode;
    rerender();
    expect(result.current.hook.sendCode).toBe(before);
  });
});

describe("useSignInWithEmailShortCode", () => {
  const render = (storage?: TokenStorage) =>
    renderWithProviders(
      () =>
        useSignInWithEmailShortCode({
          signInWithEmailShortCode: signInMutation,
        }),
      storage,
    );

  test("presents the code with the secret, adopts the session, clears the secret", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "0471 8295" });
    });

    expect(returned).toEqual({ status: "complete" });
    // The server removes the spaces: the hook sends the code as typed.
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "0471 8295",
      browserSecret: "secret-1",
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(secretStorage.get(SECRET_KEY)).toBeNull();
  });

  test("does not report isLoading while the code is checked", async () => {
    // The user acts on the current page: the auth state must not change,
    // or a guard that shows a spinner while loading would unmount the form.
    secretStorage.set(SECRET_KEY, "secret-1");
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.hook.signIn({ code: "04718295" });
    });
    await waitFor(() => expect(result.current.hook.pending).toBe(true));
    expect(result.current.auth.isLoading).toBe(false);

    await act(async () => {
      resolveMutation({
        status: "error",
        userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
      });
      await done;
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("is MISSING_SECRET when this browser did not ask for a code", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "04718295" });
    });
    expect(returned).toEqual({
      status: "error",
      userError: { error: "MISSING_SECRET" },
    });
    expect(runSignInMutation).not.toHaveBeenCalled();
  });

  test("keeps the secret after an incorrect code, so the user can retry", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    runSignInMutation
      .mockResolvedValueOnce({
        status: "error",
        userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
      })
      .mockResolvedValueOnce({ status: "complete", tokens: bundle });
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let first!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      first = await result.current.hook.signIn({ code: "00000000" });
    });
    expect(first).toEqual({
      status: "error",
      userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
    });
    expect(secretStorage.get(SECRET_KEY)).toBe("secret-1");

    let second!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      second = await result.current.hook.signIn({ code: "04718295" });
    });
    expect(second).toEqual({ status: "complete" });
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = render();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn({ code: "04718295" });
    });
    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("without localStorage (React Native), uses the provider's storage", async () => {
    const storage = new InMemoryStorage();
    await new NamespacedStorage(storage, NAMESPACE).set(SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = render(storage);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.hook.signIn({ code: "04718295" });
    });
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "04718295",
      browserSecret: "secret-1",
    });
    expect(window.localStorage.length).toBe(0);
  });
});
