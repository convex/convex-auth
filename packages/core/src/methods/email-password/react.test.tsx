// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { anyApi, makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage, NamespacedStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import {
  useCompleteChangeEmail,
  useCompletePasswordRecovery,
  useCompleteSignUp,
  useSignInWithEmailPassword,
  useSignUpWithEmailPassword,
  useStartChangeEmail,
  useStartPasswordRecovery,
} from "./react.tsx";

// The hooks that mint a session run their mutation through the injected
// `AuthSignInApi`, so the test substitutes a signInApi rather than mocking
// `convex/react`.
const { signInApi, run: runSignInMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

// The hooks read the deployment URL from the surrounding ConvexProvider to
// namespace their secret storage, and the hooks that do not mint a session
// run their mutation through this client. The client never connects: the
// tests stub its `mutation` method and no test subscribes to a query.
const convexClient = new ConvexReactClient(NAMESPACE);
const stubConvexMutation = () => vi.spyOn(convexClient, "mutation");

// The hooks keep flow secrets in `localStorage` (jsdom supplies one),
// namespaced like the hooks namespace it.
const secretStorage = new NamespacedStorage(window.localStorage, NAMESPACE);
const SIGN_UP_SECRET_KEY = "__convexAuthEmailPasswordSignUpSecret";
const CHANGE_EMAIL_SECRET_KEY = "__convexAuthEmailPasswordChangeEmailSecret";
const RECOVERY_SECRET_KEY = "__convexAuthEmailPasswordRecoverySecret";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The hooks read the function name of the reference to keep their callbacks
// stable, so they need a real one. The stub signInApi ignores it.
const signInMutation = makeFunctionReference<"mutation">(
  "auth:signIn",
) as never;

// `useMutation` reads the function name of its reference, so the hooks that
// go through the Convex client need a real one. The stubbed client ignores it.
const convexMutation = makeFunctionReference<"mutation">("auth:flow") as never;
const convexQuery = makeFunctionReference<"query">("auth:check") as never;

// A stand-in for the subscription of a query: the hooks that subscribe go
// through `convexClient.watchQuery`. `emit` gives the subscription a new
// result, or an `Error` when the query fails.
function stubConvexQuery() {
  const listeners = new Set<() => void>();
  let result: unknown = undefined;
  const watch = vi.spyOn(convexClient, "watchQuery").mockImplementation(
    () =>
      ({
        onUpdate: (callback: () => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        localQueryResult: () => {
          if (result instanceof Error) throw result;
          return result;
        },
        journal: () => undefined,
      }) as never,
  );
  return {
    watch,
    emit: (next: unknown) => {
      result = next;
      for (const listener of listeners) listener();
    },
  };
}

function renderWithProviders<T>(useHook: () => T) {
  const authClient = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  // StrictMode runs effects twice in development. The landing page hooks
  // must present a one-shot link once regardless.
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

describe("useSignInWithEmailPassword", () => {
  const credentials = {
    email: "alice@example.com",
    password: "correct horse battery staple",
  };

  test("adopts the minted session", async () => {
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword({ signInWithEmailPassword: signInMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn(credentials);
    });

    expect(runSignInMutation).toHaveBeenCalledWith(credentials);
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("returns a user error without a session", async () => {
    const failure = {
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    };
    runSignInMutation.mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword({ signInWithEmailPassword: signInMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn(credentials);
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword({ signInWithEmailPassword: signInMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn(credentials);
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("stays pending until the last overlapping call ends", async () => {
    const failure = {
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    };
    const resolvers: Array<(value: unknown) => void> = [];
    runSignInMutation.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword({ signInWithEmailPassword: signInMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.hook.signIn(credentials);
      second = result.current.hook.signIn(credentials);
    });
    expect(result.current.hook.pending).toBe(true);

    await act(async () => {
      resolvers[0](failure);
      await first;
    });
    expect(result.current.hook.pending).toBe(true);

    await act(async () => {
      resolvers[1](failure);
      await second;
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("signIn keeps its identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is. It returns a new reference
    // object on each property access.
    const { result, rerender } = renderWithProviders(() =>
      useSignInWithEmailPassword(anyApi.auth as never),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.hook.signIn;

    rerender();

    expect(result.current.hook.signIn).toBe(first);
  });
});

describe("useSignUpWithEmailPassword", () => {
  const credentials = {
    email: "alice@example.com",
    password: "correct horse battery staple",
  };

  test("success stores the secret and does not sign in", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword({ signUpWithEmailPassword: convexMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp(credentials);
    });

    // Sign-up mints no session, so it goes straight to Convex: under SSR the
    // signInApi is the auth proxy, which refuses a non-envelope result.
    expect(mutation.mock.calls[0]?.[1]).toEqual(credentials);
    expect(runSignInMutation).not.toHaveBeenCalled();
    expect(returned).toEqual({ success: true });
    // The secret is kept for the completion step; no session was adopted.
    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a user error stores nothing", async () => {
    const failure = { success: false, userError: { error: "EMAIL_TAKEN" } };
    stubConvexMutation().mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword({ signUpWithEmailPassword: convexMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp(credentials);
    });

    expect(returned).toEqual(failure);
    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBeNull();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    stubConvexMutation().mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword({ signUpWithEmailPassword: convexMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp(credentials);
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });
});

describe("useCompleteSignUp", () => {
  test("presents the link once as the page opens, adopts the session, clears the secret", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(
        { completeSignUp: signInMutation },
        { emailCode: "code-1" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );

    // The mutation received the code from the link plus the stored secret.
    expect(runSignInMutation).toHaveBeenCalledTimes(1);
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    // The secret is cleared once it has served its purpose.
    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBeNull();
  });

  test("presents the link once when the effect runs again", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    // Keep the mutation in flight, so the secret is still stored when the
    // effect runs again.
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    let emailCode = "code-1";
    const { result, rerender } = renderWithProviders(() =>
      useCompleteSignUp({ completeSignUp: signInMutation }, { emailCode }),
    );
    await waitFor(() => expect(runSignInMutation).toHaveBeenCalledTimes(1));

    // A new code changes the effect's dependencies, so the effect runs again.
    emailCode = "code-2";
    rerender();
    await act(async () => {
      resolveMutation({ status: "complete", tokens: bundle });
    });
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );

    expect(runSignInMutation).toHaveBeenCalledTimes(1);
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
  });

  test("reports isLoading while the link is validated", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(
        { completeSignUp: signInMutation },
        { emailCode: "code-1" },
      ),
    );
    await waitFor(() => expect(runSignInMutation).toHaveBeenCalledTimes(1));

    // The app does not see a signed-out user while the mutation runs.
    expect(result.current.auth).toMatchObject({
      isLoading: true,
      isAuthenticated: false,
    });

    await act(async () => {
      resolveMutation({ status: "complete", tokens: bundle });
    });
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );
    expect(result.current.auth).toMatchObject({
      isLoading: false,
      isAuthenticated: true,
    });
  });

  test("is MISSING_SECRET when this browser did not start the flow", async () => {
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(
        { completeSignUp: signInMutation },
        { emailCode: "code-1" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "MISSING_SECRET" },
      }),
    );

    // The backend was never called: there was nothing to present.
    expect(runSignInMutation).not.toHaveBeenCalled();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("keeps the secret when the completion fails", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(
        { completeSignUp: signInMutation },
        { emailCode: "code-1" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "INVALID_CHALLENGE" },
      }),
    );

    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown mutation becomes an OTHER_ERROR state preserving cause", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(
        { completeSignUp: signInMutation },
        { emailCode: "code-1" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "OTHER_ERROR", cause },
      }),
    );
  });
});

describe("useStartPasswordRecovery", () => {
  test("success stores the secret", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-9",
      sentTo: "Alice@example.com",
    });
    const { result } = renderWithProviders(() =>
      useStartPasswordRecovery({ startPasswordRecovery: convexMutation }),
    );

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.startPasswordRecovery>
    >;
    await act(async () => {
      returned = await result.current.hook.startPasswordRecovery({
        email: "alice@example.com",
      });
    });

    expect(mutation.mock.calls[0]?.[1]).toEqual({ email: "alice@example.com" });
    expect(returned).toEqual({ success: true, sentTo: "Alice@example.com" });
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBe("secret-9");
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    stubConvexMutation().mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useStartPasswordRecovery({ startPasswordRecovery: convexMutation }),
    );

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.startPasswordRecovery>
    >;
    await act(async () => {
      returned = await result.current.hook.startPasswordRecovery({
        email: "alice@example.com",
      });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBeNull();
  });
});

describe("useCompletePasswordRecovery", () => {
  // The stub signInApi ignores the mutation reference, so any value will do.
  // The stubbed client reads the name of the query reference.
  const recoveryApi = {
    checkPasswordRecovery: convexQuery,
    completePasswordRecovery: signInMutation,
  };
  const checkPassed = { success: true };
  const linkDead = {
    success: false,
    userError: { error: "INVALID_CHALLENGE" },
  };

  test("subscribes to the check, and is ready only after it passes", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    expect(result.current.hook).toEqual({ status: "loading" });
    expect(watch.mock.calls[0]?.[1]).toEqual({
      emailCode: "code-9",
      browserSecret: "secret-9",
    });

    act(() => emit(checkPassed));
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
  });

  test("a failing check ends the flow without a form", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    act(() => emit({ success: false, userError: { error: "INCORRECT_CODE" } }));
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "INCORRECT_CODE" },
      }),
    );
  });

  test("a failing query throws like `useQuery` does", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    const cause = new Error("server bug");
    renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    expect(() => act(() => emit(cause))).toThrow(cause);
  });

  test("a link that dies while the page is open ends the flow", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    act(() => emit(checkPassed));
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));

    // Another tab claims the link, or the server erases it after it expires.
    act(() => emit(linkDead));
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "INVALID_CHALLENGE" },
      }),
    );
  });

  test("completing adopts the session and clears the secret", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    runSignInMutation.mockResolvedValueOnce({
      status: "complete",
      tokens: bundle,
    });
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    act(() => emit(checkPassed));
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    let returned!: Awaited<ReturnType<typeof ready.completePasswordRecovery>>;
    await act(async () => {
      returned = await ready.completePasswordRecovery({
        newPassword: "brand new horse staple",
      });
    });

    expect(runSignInMutation).toHaveBeenLastCalledWith({
      emailCode: "code-9",
      browserSecret: "secret-9",
      newPassword: "brand new horse staple",
    });
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.hook).toEqual({ status: "complete" });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBeNull();

    // The claim erased the link. The check now fails, but the flow is over.
    act(() => emit(linkDead));
    expect(result.current.hook).toEqual({ status: "complete" });
  });

  test("the claim reaching the subscription during submit keeps the form", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    let finishSubmit!: (value: unknown) => void;
    runSignInMutation.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSubmit = resolve;
      }),
    );
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    act(() => emit(checkPassed));
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    let submitted!: ReturnType<typeof ready.completePasswordRecovery>;
    act(() => {
      submitted = ready.completePasswordRecovery({
        newPassword: "brand new horse staple",
      });
    });
    await waitFor(() =>
      expect(result.current.hook).toMatchObject({
        status: "ready",
        pending: true,
      }),
    );

    // The mutation's own claim of the link reaches the subscription first.
    act(() => emit(linkDead));
    expect(result.current.hook).toMatchObject({
      status: "ready",
      pending: true,
    });

    await act(async () => {
      finishSubmit({ status: "complete", tokens: bundle });
      await submitted;
    });
    expect(result.current.hook).toEqual({ status: "complete" });
  });

  test("is MISSING_SECRET without a check when this browser did not start the flow", async () => {
    const { watch } = stubConvexQuery();
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "MISSING_SECRET" },
      }),
    );
    expect(watch).not.toHaveBeenCalled();
  });

  test("a rejected password leaves the flow ready for another try", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    const failure = {
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 },
    };
    runSignInMutation.mockResolvedValueOnce(failure);
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    act(() => emit(checkPassed));
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    let returned!: Awaited<ReturnType<typeof ready.completePasswordRecovery>>;
    await act(async () => {
      returned = await ready.completePasswordRecovery({ newPassword: "short" });
    });

    expect(returned).toEqual(failure);
    expect(result.current.hook.status).toBe("ready");
    // The link was not consumed: the secret must still work.
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBe("secret-9");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a link that dies after the check ends the flow at submit", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const { watch, emit } = stubConvexQuery();
    runSignInMutation.mockResolvedValueOnce({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(recoveryApi, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(watch).toHaveBeenCalled());
    act(() => emit(checkPassed));
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    await act(async () => {
      await ready.completePasswordRecovery({ newPassword: "brand new horse" });
    });

    expect(result.current.hook).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});

describe("useStartChangeEmail", () => {
  test("success stores the secret", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-5",
    });
    const { result } = renderWithProviders(() =>
      useStartChangeEmail({ startChangeEmail: convexMutation }),
    );

    const args = {
      newEmail: "alice@new.example.com",
      currentPassword: "correct horse battery staple",
    };
    let returned!: Awaited<
      ReturnType<typeof result.current.hook.startChangeEmail>
    >;
    await act(async () => {
      returned = await result.current.hook.startChangeEmail(args);
    });

    expect(mutation.mock.calls[0]?.[1]).toEqual(args);
    expect(returned).toEqual({ success: true });
    expect(secretStorage.get(CHANGE_EMAIL_SECRET_KEY)).toBe("secret-5");
  });

  test("a user error stores nothing", async () => {
    const failure = {
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    };
    stubConvexMutation().mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useStartChangeEmail({ startChangeEmail: convexMutation }),
    );

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.startChangeEmail>
    >;
    await act(async () => {
      returned = await result.current.hook.startChangeEmail({
        newEmail: "alice@new.example.com",
        currentPassword: "wrong",
      });
    });

    expect(returned).toEqual(failure);
    expect(secretStorage.get(CHANGE_EMAIL_SECRET_KEY)).toBeNull();
  });
});

describe("useCompleteChangeEmail", () => {
  test("presents the link once as the page opens and clears the secret", async () => {
    secretStorage.set(CHANGE_EMAIL_SECRET_KEY, "secret-5");
    const mutation = stubConvexMutation().mockResolvedValue({ success: true });
    const { result } = renderWithProviders(() =>
      useCompleteChangeEmail(
        { completeChangeEmail: convexMutation },
        { emailCode: "code-5" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      emailCode: "code-5",
      browserSecret: "secret-5",
    });
    expect(secretStorage.get(CHANGE_EMAIL_SECRET_KEY)).toBeNull();
    // No session is minted by this flow.
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("is MISSING_SECRET when this browser did not start the flow", async () => {
    const mutation = stubConvexMutation();
    const { result } = renderWithProviders(() =>
      useCompleteChangeEmail(
        { completeChangeEmail: convexMutation },
        { emailCode: "code-5" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "MISSING_SECRET" },
      }),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  test("keeps the secret when the completion fails", async () => {
    secretStorage.set(CHANGE_EMAIL_SECRET_KEY, "secret-5");
    stubConvexMutation().mockResolvedValue({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
    const { result } = renderWithProviders(() =>
      useCompleteChangeEmail(
        { completeChangeEmail: convexMutation },
        { emailCode: "code-5" },
      ),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "NOT_LOGGED_IN" },
      }),
    );
    expect(secretStorage.get(CHANGE_EMAIL_SECRET_KEY)).toBe("secret-5");
  });
});
