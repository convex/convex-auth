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
  useSendEmailMagicLink,
  useSignInWithEmailMagicLink,
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
const SECRET_KEY = "__convexAuthEmailMagicLinkSecret";

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
  // StrictMode runs effects twice in development. The landing page hook must
  // present a one-shot link once regardless.
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

describe("useSendEmailMagicLink", () => {
  const args = { email: "alice@example.com" };

  test("success stores the secret and does not sign in", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const { result } = renderWithProviders(() =>
      useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.sendMagicLink>
    >;
    await act(async () => {
      returned = await result.current.hook.sendMagicLink(args);
    });

    // Sending the link mints no session, so it goes straight to Convex: under
    // SSR the signInApi is the auth proxy, which refuses a non-envelope
    // result.
    expect(mutation.mock.calls[0]?.[1]).toEqual(args);
    expect(runSignInMutation).not.toHaveBeenCalled();
    // The secret stays out of the result: the hook keeps it for the landing
    // page.
    expect(returned).toEqual({ success: true });
    expect(secretStorage.get(SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a second link replaces the secret of the first", async () => {
    stubConvexMutation()
      .mockResolvedValueOnce({ success: true, browserSecret: "secret-1" })
      .mockResolvedValueOnce({ success: true, browserSecret: "secret-2" });
    const { result } = renderWithProviders(() =>
      useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.hook.sendMagicLink(args);
      await result.current.hook.sendMagicLink(args);
    });

    expect(secretStorage.get(SECRET_KEY)).toBe("secret-2");
  });

  test("a user error stores nothing", async () => {
    const failure = {
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: 1000 },
    };
    stubConvexMutation().mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.sendMagicLink>
    >;
    await act(async () => {
      returned = await result.current.hook.sendMagicLink(args);
    });

    expect(returned).toEqual(failure);
    expect(secretStorage.get(SECRET_KEY)).toBeNull();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    stubConvexMutation().mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.sendMagicLink>
    >;
    await act(async () => {
      returned = await result.current.hook.sendMagicLink(args);
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("stays pending until the last overlapping call ends", async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    stubConvexMutation().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }) as never,
    );
    const { result } = renderWithProviders(() =>
      useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.hook.pending).toBe(false);

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.hook.sendMagicLink(args);
      second = result.current.hook.sendMagicLink(args);
    });
    await waitFor(() => expect(result.current.hook.pending).toBe(true));

    await act(async () => {
      resolvers[0]({ success: true, browserSecret: "secret-1" });
      await first;
    });
    expect(result.current.hook.pending).toBe(true);

    await act(async () => {
      resolvers[1]({ success: true, browserSecret: "secret-2" });
      await second;
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("sendMagicLink keeps its identity across rerenders", async () => {
    const { result, rerender } = renderWithProviders(() =>
      useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const before = result.current.hook.sendMagicLink;
    rerender();
    expect(result.current.hook.sendMagicLink).toBe(before);
  });
});

describe("useSignInWithEmailMagicLink", () => {
  const renderLanding = (emailCode: () => string = () => "code-1") =>
    renderWithProviders(() =>
      useSignInWithEmailMagicLink(
        { signInWithEmailMagicLink: signInMutation },
        { emailCode: emailCode() },
      ),
    );

  test("presents the link once as the page opens, adopts the session, clears the secret", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderLanding();
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
    expect(secretStorage.get(SECRET_KEY)).toBeNull();
  });

  test("presents the link once when the effect runs again", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    // Keep the mutation in flight, so the secret is still stored when the
    // effect runs again.
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    let emailCode = "code-1";
    const { result, rerender } = renderLanding(() => emailCode);
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

  test("reports isLoading while the link is checked", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderLanding();
    await waitFor(() => expect(runSignInMutation).toHaveBeenCalledTimes(1));

    // The app does not see a signed-out user while the mutation runs.
    expect(result.current.hook).toEqual({ status: "loading" });
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

  test("is MISSING_SECRET when this browser did not ask for the link", async () => {
    const { result } = renderLanding();
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

  test("keeps the secret when the sign-in fails", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({
      status: "error",
      userError: { error: "INCORRECT_CODE" },
    });
    const { result } = renderLanding();
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "INCORRECT_CODE" },
      }),
    );

    // The person may have opened an older link: the newest one still works.
    expect(secretStorage.get(SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown mutation becomes an OTHER_ERROR state preserving cause", async () => {
    secretStorage.set(SECRET_KEY, "secret-1");
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = renderLanding();
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "OTHER_ERROR", cause },
      }),
    );
  });
});

describe("without localStorage (React Native)", () => {
  test("the secret stays in the provider's storage, and a later screen signs in with it", async () => {
    const storage = new InMemoryStorage();
    stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const send = renderWithProviders(
      () => useSendEmailMagicLink({ sendEmailMagicLink: sendMutation }),
      storage,
    );
    await waitFor(() => expect(send.result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await send.result.current.hook.sendMagicLink({
        email: "alice@example.com",
      });
    });
    expect(window.localStorage.length).toBe(0);
    send.unmount();

    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const landing = renderWithProviders(
      () =>
        useSignInWithEmailMagicLink(
          { signInWithEmailMagicLink: signInMutation },
          { emailCode: "code-1" },
        ),
      storage,
    );
    await waitFor(() =>
      expect(landing.result.current.hook).toEqual({ status: "complete" }),
    );
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
  });
});
