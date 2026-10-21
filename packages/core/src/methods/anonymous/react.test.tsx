// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { anyApi, makeFunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { useAuthToken } from "../../react/index.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import { SignInAnonymouslyMutation, useSignInAnonymously } from "./react.tsx";

// The hook runs its sign-in mutation through the injected `AuthSignInApi`, so the
// test substitutes a signInApi rather than mocking `convex/react`.
const { signInApi, run: runSignIn } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// A stand-in for the app's `api.auth.signInAnonymously` reference. The hook
// reads its function name, and the stub signInApi ignores it.
const signInAnonymous = makeFunctionReference<"mutation">(
  "auth:signInAnonymously",
) as SignInAnonymouslyMutation;

function renderAnonymousAuth(
  api: { signInAnonymously: SignInAnonymouslyMutation } = {
    signInAnonymously: signInAnonymous,
  },
) {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  return renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      anonymous: useSignInAnonymously(api),
    }),
    { wrapper },
  );
}

describe("useSignInAnonymously", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runSignIn.mockReset();
  });

  test("signIn adopts the envelope's bundle from signInAnonymous into the core client", async () => {
    runSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderAnonymousAuth();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);

    await act(async () => {
      await result.current.anonymous.signIn();
    });

    expect(runSignIn).toHaveBeenCalledTimes(1);
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("signIn keeps its identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is. It returns a new reference
    // object on each property access.
    const { result, rerender } = renderAnonymousAuth(anyApi.auth as never);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.anonymous.signIn;

    rerender();

    expect(result.current.anonymous.signIn).toBe(first);
  });
});
