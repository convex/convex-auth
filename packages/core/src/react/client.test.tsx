// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SpaAuthApi, AuthClient } from "../browser/sessionManager.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "../browser/storage.ts";
import type { TokenBundle } from "../lib/types.ts";
import { AuthProvider, useAuth } from "./client.tsx";
import { stubSignInApi } from "./testSignInApi.ts";
import { useAuthActions, useAuthToken } from "./index.tsx";

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

/** An unsigned JWT for `sub`. The client decodes tokens but never verifies them. */
function jwt(sub: string, n: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ sub, n })}.sig`;
}

function jwtBundle(sub: string, n: number): TokenBundle {
  return { ...bundle(n), accessToken: jwt(sub, n), userId: sub };
}

/**
 * Render the provider under Convex's real `ConvexProviderWithAuth` with a fake
 * client that records each `setAuth` call, i.e. each auth handshake.
 */
async function renderWithConvex(client: AuthClient) {
  const fetchers: ((args: {
    forceRefreshToken: boolean;
  }) => Promise<string | null | undefined>)[] = [];
  const convex = {
    setAuth: (fetchToken: (typeof fetchers)[number]) => {
      fetchers.push(fetchToken);
    },
    clearAuth: () => {},
  };
  render(
    <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
      <ConvexProviderWithAuth
        client={convex as unknown as ConvexReactClient}
        useAuth={useAuth}
      >
        {null}
      </ConvexProviderWithAuth>
    </AuthProvider>,
  );
  await waitFor(() => expect(client.getSnapshot().isLoading).toBe(false));
  return fetchers;
}

describe("Convex auth handshake", () => {
  test("re-runs when a different user signs in while signed in", async () => {
    const { client } = makeClient();
    const fetchers = await renderWithConvex(client);
    await act(async () => {
      await client.setSession(jwtBundle("user-a", 1));
    });
    expect(fetchers).toHaveLength(1);

    await act(async () => {
      await client.setSession(jwtBundle("user-b", 2));
    });

    expect(fetchers).toHaveLength(2);
    expect(await fetchers[1]({ forceRefreshToken: false })).toBe(
      jwt("user-b", 2),
    );
  });

  test("re-runs when a different user signs in after signing out", async () => {
    const { client } = makeClient();
    const fetchers = await renderWithConvex(client);
    await act(async () => {
      await client.setSession(jwtBundle("user-a", 1));
    });
    await act(async () => {
      await client.signOut();
      await client.setSession(jwtBundle("user-b", 2));
    });

    expect(fetchers).toHaveLength(2);
    expect(await fetchers[1]({ forceRefreshToken: false })).toBe(
      jwt("user-b", 2),
    );
  });

  test("re-runs when another tab switches to a different user", async () => {
    const { client, storage } = makeClient();
    const fetchers = await renderWithConvex(client);
    await act(async () => {
      await client.setSession(jwtBundle("user-a", 1));
    });
    expect(fetchers).toHaveLength(1);

    const event = Object.assign(new Event("storage"), {
      storageArea: storage,
      key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
      newValue: jwt("user-b", 2),
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(fetchers).toHaveLength(2);
  });

  test("does not re-run when the same user's token is refreshed", async () => {
    const { client } = makeClient({
      refreshSession: async () => ({
        kind: "rotated" as const,
        tokens: jwtBundle("user-a", 2),
      }),
    });
    const fetchers = await renderWithConvex(client);
    await act(async () => {
      await client.setSession(jwtBundle("user-a", 1));
    });
    expect(fetchers).toHaveLength(1);

    await act(async () => {
      await fetchers[0]({ forceRefreshToken: true });
    });

    expect(fetchers).toHaveLength(1);
    expect(await fetchers[0]({ forceRefreshToken: false })).toBe(
      jwt("user-a", 2),
    );
  });
});
