// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SpaAuthApi, AuthClient } from "../browser/sessionManager.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "../browser/storage.ts";
import type { TokenBundle } from "../lib/types.ts";
import { AuthProvider, SessionWatcher, useAuth } from "./client.tsx";
import { stubSignInApi } from "./testSignInApi.ts";
import { useAuthActions, useAuthToken } from "./index.tsx";

// `SessionWatcher` subscribes through convex/react's `useQuery` and gates on
// its `useConvexAuth`, which need a live Convex client; the suite stubs just
// those hooks (everything else stays real) and scripts the server's answers
// per test.
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: vi.fn(),
  useConvexAuth: vi.fn(),
}));

const NAMESPACE = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 0,
    userId: "user-1",
  };
}

function makeClient(
  authApi: Partial<SpaAuthApi> = {},
  storage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

/** Render the provider around a hook and expose every auth hook's value. */
function renderAuth(client: AuthClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
      {children}
    </AuthProvider>
  );
  return renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      actions: useAuthActions(),
    }),
    { wrapper },
  );
}

describe("React bindings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("useAuth throws when used outside a provider", () => {
    expect(() => renderHook(() => useAuth())).toThrow(
      /useAuth must be used within a <ConvexAuthProvider>/,
    );
  });

  test("useAuthActions throws when used outside a provider", () => {
    expect(() => renderHook(() => useAuthActions())).toThrow(
      /useAuthActions must be used within a <ConvexAuthProvider>/,
    );
  });

  test("useAuthToken returns null when used outside a provider", () => {
    // The token context has a null default rather than throwing.
    const { result } = renderHook(() => useAuthToken());
    expect(result.current).toBeNull();
  });

  test("AuthProvider initializes the client on mount and disposes on unmount", async () => {
    const { client } = makeClient();
    const init = vi.spyOn(client, "init");
    const dispose = vi.spyOn(client, "dispose");

    const { unmount } = render(
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        hi
      </AuthProvider>,
    );
    expect(init).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("reports loading then unauthenticated for an empty store", async () => {
    const { client } = makeClient();
    const { result } = renderAuth(client);

    expect(result.current.auth.isLoading).toBe(true);

    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });

  test("hydrates a persisted session and exposes the token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const { client } = makeClient({}, storage);

    const { result } = renderAuth(client);

    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(result.current.auth.isLoading).toBe(false);
    expect(result.current.token).toBe("access-1");
  });

  test("setSession authenticates and re-renders consumers", async () => {
    const { client } = makeClient();
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });

    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("fetchAccessToken from the auth context returns the current token", async () => {
    const { client } = makeClient();
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });

    const token = await result.current.auth.fetchAccessToken({
      forceRefreshToken: false,
    });
    expect(token).toBe("access-1");
  });

  test("signOut revokes on the server and clears consumers", async () => {
    const signOut = vi.fn(async (rt: string) => {
      expect(rt).toBe("refresh-1");
    });
    const { client } = makeClient({ signOut });
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });
    expect(result.current.auth.isAuthenticated).toBe(true);

    await act(async () => {
      await result.current.actions.signOut();
    });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });

  test("propagates a cross-tab sign-out after the provider remounts", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);

    // Remounting the same client — React StrictMode's mount → unmount → mount in
    // dev, or an ordinary route change — disposes then re-inits it. Cross-tab
    // sign-out must still work afterward, which only holds if the re-init
    // re-attaches the window storage listener the dispose removed.
    render(
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        hi
      </AuthProvider>,
    ).unmount();

    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(async () => {
      await result.current.actions.setSession(bundle(1));
    });
    expect(result.current.auth.isAuthenticated).toBe(true);

    // Another tab cleared the JWT key: dispatch the storage event to the window
    // listener the re-init should have re-attached.
    const event = Object.assign(new Event("storage"), {
      storageArea: storage,
      key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
      newValue: null,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });
});

describe("SessionWatcher", () => {
  const isAuthenticatedRef = makeFunctionReference<"query">(
    "auth:isAuthenticated",
  );

  /**
   * Script the mocked hooks: `useConvexAuth` reports whether the backend has
   * accepted the token, and `useQuery` behaves like the real one, `"skip"`
   * yielding `undefined` and anything else the given server answer.
   */
  function serve({
    convexAuthenticated,
    hasLiveSession,
  }: {
    convexAuthenticated: boolean;
    hasLiveSession: boolean | undefined;
  }) {
    vi.mocked(useConvexAuth).mockReturnValue({
      isLoading: false,
      isAuthenticated: convexAuthenticated,
      isRefreshing: false,
    } as ReturnType<typeof useConvexAuth>);
    vi.mocked(useQuery).mockImplementation(((
      _ref: unknown,
      args: unknown,
    ): boolean | undefined =>
      args === "skip"
        ? undefined
        : hasLiveSession) as unknown as typeof useQuery);
  }

  /** A client hydrated as signed-in, with a spy on the server sign-out. */
  function makeAuthenticatedClient() {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const signOut = vi.fn(async () => {});
    const { client } = makeClient({ signOut }, storage);
    return { client, signOut };
  }

  function renderWatcher(client: AuthClient) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        <SessionWatcher isAuthenticated={isAuthenticatedRef} />
        {children}
      </AuthProvider>
    );
    return renderHook(() => useAuth(), { wrapper });
  }

  test("signs out when the server reports the session is gone", async () => {
    const { client, signOut } = makeAuthenticatedClient();
    serve({ convexAuthenticated: true, hasLiveSession: true });

    const { result, rerender } = renderWatcher(client);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // The session is revoked server-side: the subscription's next answer is
    // `false`, which clears the local session.
    serve({ convexAuthenticated: true, hasLiveSession: false });
    rerender();

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  test("stays signed in while the server reports the session live", async () => {
    const { client, signOut } = makeAuthenticatedClient();
    serve({ convexAuthenticated: true, hasLiveSession: true });

    const { result } = renderWatcher(client);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(vi.mocked(useQuery)).toHaveBeenLastCalledWith(
      isAuthenticatedRef,
      {},
    );

    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("does not subscribe until the backend accepts the token", async () => {
    // Signed in locally, but the Convex connection has no accepted token (the
    // handshake is pending, or the client gave up on auth). A query run now
    // would see no identity and answer `false` without the session being
    // gone, so the watcher must not ask.
    const { client, signOut } = makeAuthenticatedClient();
    serve({ convexAuthenticated: false, hasLiveSession: false });

    const { result } = renderWatcher(client);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    expect(vi.mocked(useQuery)).toHaveBeenLastCalledWith(
      isAuthenticatedRef,
      "skip",
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("stops subscribing when the backend drops the token", async () => {
    const { client, signOut } = makeAuthenticatedClient();
    serve({ convexAuthenticated: true, hasLiveSession: true });

    const { result, rerender } = renderWatcher(client);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // The Convex client cleared its auth (say, a refresh failed on the
    // network): the gate closes, so the no-identity re-run is never read.
    serve({ convexAuthenticated: false, hasLiveSession: false });
    rerender();

    expect(vi.mocked(useQuery)).toHaveBeenLastCalledWith(
      isAuthenticatedRef,
      "skip",
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });
});
