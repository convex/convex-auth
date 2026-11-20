// @vitest-environment jsdom
/**
 * Tests what happens in React when the client moves from one live session to
 * another: the Convex client must authenticate again, and `SessionWatcher`
 * must not sign the client out on the way.
 *
 * `ConvexProviderWithAuth`, `useConvexAuth`, `AuthProvider` and
 * `SessionWatcher` are real. The Convex client is a stand-in that records
 * `setAuth` and `clearAuth` and answers like the backend, and `useQuery` is
 * scripted, since the suite has no deployment.
 *
 * @module
 */
import { act, render, waitFor } from "@testing-library/react";
import {
  ConvexProviderWithAuth,
  type ConvexReactClient,
  useConvexAuth,
  useQuery,
} from "convex/react";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient, type SpaAuthApi } from "../browser/sessionManager.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import type {
  IsAuthenticatedFn,
  RefreshResult,
  TokenBundle,
} from "../lib/types.ts";
import { AuthProvider, SessionWatcher, useAuth } from "./client.tsx";
import { stubSignInApi } from "./testSignInApi.ts";

vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: vi.fn(),
}));

const isAuthenticatedRef = makeFunctionReference<"query">(
  "auth:isAuthenticated",
) as unknown as IsAuthenticatedFn;

/** An access token of the given session, readable like a real one. */
function accessTokenOf(sessionId: string, serial = 0): string {
  const payload = btoa(JSON.stringify({ sub: sessionId, serial }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `header.${payload}.signature`;
}

function bundleOf(sessionId: string, serial = 0): TokenBundle {
  return {
    accessToken: accessTokenOf(sessionId, serial),
    refreshToken: `refresh-${sessionId}-${serial}`,
    refreshTokenExpiresAt: 0,
    userId: `user-of-${sessionId}`,
  };
}

type FetchToken = (args: {
  forceRefreshToken: boolean;
}) => Promise<string | null>;

/**
 * A stand-in for the Convex client. `setAuth` asks for the cached token and
 * reports it as accepted, as the real client does once the backend confirmed
 * it. `rejectToken` reports what the real client reports when the backend
 * rejected the token and the next one it was given is the same.
 */
function fakeConvexClient() {
  let onAuthChange: ((isAuthenticated: boolean) => void) | null = null;
  const authenticatedWith: Array<string | null> = [];
  const setAuth = vi.fn(
    (fetchToken: FetchToken, onChange: (isAuthenticated: boolean) => void) => {
      onAuthChange = onChange;
      void fetchToken({ forceRefreshToken: false }).then((token) => {
        authenticatedWith.push(token);
        onChange(token !== null);
      });
    },
  );
  const clearAuth = vi.fn();
  return {
    client: { setAuth, clearAuth } as unknown as ConvexReactClient,
    setAuth,
    clearAuth,
    /** The token of each authentication, in order. */
    authenticatedWith,
    rejectToken: () => onAuthChange?.(false),
  };
}

async function signedInClient(authApi: Partial<SpaAuthApi> = {}) {
  const signOut = vi.fn(async () => {});
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut,
      ...authApi,
    },
    storage: new InMemoryStorage(),
    storageNamespace: "https://happy-animal-123.convex.cloud",
  });
  await client.init();
  await client.setSession(bundleOf("session-a"));
  return { client, signOut };
}

/** What `useConvexAuth` reported at each render. */
function AuthStateRecorder({ states }: { states: string[] }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  states.push(
    isLoading
      ? "loading"
      : isAuthenticated
        ? "authenticated"
        : "unauthenticated",
  );
  return null;
}

async function renderApp(client: AuthClient) {
  const convex = fakeConvexClient();
  const states: string[] = [];
  // The backend's answer for a live session, for as long as the query runs.
  vi.mocked(useQuery).mockImplementation((...args: unknown[]) =>
    args[1] === "skip" ? undefined : true,
  );
  render(
    <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
      <ConvexProviderWithAuth client={convex.client} useAuth={useAuth}>
        <SessionWatcher isAuthenticated={isAuthenticatedRef} />
        <AuthStateRecorder states={states} />
      </ConvexProviderWithAuth>
    </AuthProvider>,
  );
  await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
  return { convex, states };
}

type SwitchResult =
  { status: "complete"; tokens: TokenBundle } | { status: "error" };
const sessionOf = (result: SwitchResult) =>
  result.status === "complete" ? result.tokens : null;

describe("moving between two live sessions", () => {
  afterEach(() => {
    vi.mocked(useQuery).mockReset();
  });

  test("the Convex client authenticates again with the new session's token", async () => {
    const { client } = await signedInClient();
    const { convex, states } = await renderApp(client);
    expect(convex.authenticatedWith).toEqual([accessTokenOf("session-a")]);

    await act(async () => {
      await client.switchSession<SwitchResult>(
        async () => ({ status: "complete", tokens: bundleOf("session-b") }),
        sessionOf,
      );
    });

    await waitFor(() =>
      expect(convex.authenticatedWith).toEqual([
        accessTokenOf("session-a"),
        accessTokenOf("session-b"),
      ]),
    );
    // The old session's auth was cleared before the new one was set.
    expect(convex.clearAuth).toHaveBeenCalled();
    await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
    expect(states).not.toContain("unauthenticated");
  });

  test("a refresh does not make the Convex client authenticate again", async () => {
    const { client } = await signedInClient({
      refreshSession: async () => ({
        kind: "rotated",
        tokens: bundleOf("session-a", 1),
      }),
    });
    const { convex } = await renderApp(client);

    await act(async () => {
      await client.fetchAccessToken({ forceRefreshToken: true });
    });

    expect(client.getSnapshot().token).toBe(accessTokenOf("session-a", 1));
    expect(convex.setAuth).toHaveBeenCalledTimes(1);
    expect(convex.clearAuth).not.toHaveBeenCalled();
  });

  test("a switch crossed by a refresh that rotates the old session ends on the new session, with no sign-out", async () => {
    const { client, signOut } = await signedInClient({
      refreshSession: async (): Promise<RefreshResult> => ({
        kind: "rotated",
        tokens: bundleOf("session-a", 1),
      }),
    });
    const { convex, states } = await renderApp(client);
    const switchResponse = Promise.withResolvers<SwitchResult>();

    await act(async () => {
      const switched = client.switchSession(
        () => switchResponse.promise,
        sessionOf,
      );
      // A refresh of the old session completes before the switch response
      // arrives.
      await client.fetchAccessToken({ forceRefreshToken: true });
      switchResponse.resolve({
        status: "complete",
        tokens: bundleOf("session-b"),
      });
      await switched;
    });

    await waitFor(() =>
      expect(convex.authenticatedWith.at(-1)).toBe(accessTokenOf("session-b")),
    );
    await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
    expect(client.getSnapshot().sessionId).toBe("session-b");
    expect(signOut).not.toHaveBeenCalled();
    expect(states).not.toContain("unauthenticated");
  });

  test("a switch crossed by a late refresh that finds no session ends on the new session, with no sign-out", async () => {
    const { client, signOut } = await signedInClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.setSession(bundleOf("session-a"));
    const { convex, states } = await renderApp(client);
    const switchResponse = Promise.withResolvers<SwitchResult>();

    await act(async () => {
      const switched = client.switchSession(
        () => switchResponse.promise,
        sessionOf,
      );
      await client.fetchAccessToken({ forceRefreshToken: true });
      switchResponse.resolve({
        status: "complete",
        tokens: bundleOf("session-b"),
      });
      await switched;
    });

    await waitFor(() =>
      expect(convex.authenticatedWith.at(-1)).toBe(accessTokenOf("session-b")),
    );
    await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
    expect(signOut).not.toHaveBeenCalled();
    expect(states).not.toContain("unauthenticated");
  });

  test("a held refresh result signs the client out when the switch returns no session", async () => {
    const { client } = await signedInClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    const { states } = await renderApp(client);
    const switchResponse = Promise.withResolvers<SwitchResult>();

    await act(async () => {
      const switched = client.switchSession(
        () => switchResponse.promise,
        sessionOf,
      );
      await client.fetchAccessToken({ forceRefreshToken: true });
      switchResponse.resolve({ status: "error" });
      await switched;
    });

    await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
    expect(client.getSnapshot().sessionId).toBeNull();
  });

  test("when the backend rejects the old token during a pending switch, nothing is revoked and the late response is adopted", async () => {
    const { client, signOut } = await signedInClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.setSession(bundleOf("session-a"));
    const { convex, states } = await renderApp(client);
    const switchResponse = Promise.withResolvers<SwitchResult>();

    let switched: Promise<unknown>;
    await act(async () => {
      switched = client.switchSession(() => switchResponse.promise, sessionOf);
      // The old access token expired while the switch was under way. The
      // websocket asks for a new one, and gets the same one back, because
      // the refresh found no session and its result is held.
      expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
        accessTokenOf("session-a"),
      );
      // The Convex client then reports that it is not authenticated.
      convex.rejectToken();
    });
    await waitFor(() => expect(states.at(-1)).toBe("unauthenticated"));
    // `SessionWatcher` does not run its query in that state, so it revokes
    // nothing.
    expect(signOut).not.toHaveBeenCalled();
    expect(client.getSnapshot().sessionId).toBe("session-a");

    await act(async () => {
      switchResponse.resolve({
        status: "complete",
        tokens: bundleOf("session-b"),
      });
      await switched;
    });

    await waitFor(() =>
      expect(convex.authenticatedWith.at(-1)).toBe(accessTokenOf("session-b")),
    );
    await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
    expect(signOut).not.toHaveBeenCalled();
  });

  test("SessionWatcher ignores a stale false query result visible on the first render of the replacement session", async () => {
    const { client, signOut } = await signedInClient();
    const { convex, states } = await renderApp(client);
    // Simulate `isAuthenticated` returning `false` for the old session right
    // through the first render of session-b (before `ConvexProviderWithAuth`
    // clears and re-authenticates the websocket with session-b).
    vi.mocked(useQuery).mockImplementation((...args: unknown[]) => {
      if (args[1] === "skip") return undefined;
      return convex.authenticatedWith.at(-1) === accessTokenOf("session-b");
    });

    await act(async () => {
      await client.switchSession<SwitchResult>(async () => {
        return { status: "complete", tokens: bundleOf("session-b") };
      }, sessionOf);
    });

    await waitFor(() =>
      expect(convex.authenticatedWith.at(-1)).toBe(accessTokenOf("session-b")),
    );
    await waitFor(() => expect(states.at(-1)).toBe("authenticated"));
    expect(client.getSnapshot().sessionId).toBe("session-b");
    expect(signOut).not.toHaveBeenCalled();
  });
});
