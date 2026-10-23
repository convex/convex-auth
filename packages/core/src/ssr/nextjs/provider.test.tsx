// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryStorage } from "../../browser/storage.ts";
import { NAMESPACE, bundle } from "../../methods/oauth/testFlow.ts";
import { useAuthActions, useAuthToken } from "../../react/index.tsx";
import {
  ConvexAuthNextjsProvider,
  ConvexAuthNextjsServerStateProvider,
} from "./client.tsx";

/** A real Convex client that never opens a socket. */
function makeConvexClient() {
  const client = new ConvexReactClient(NAMESPACE);
  vi.spyOn(client, "setAuth").mockImplementation(() => {});
  vi.spyOn(client, "clearAuth").mockImplementation(() => {});
  return client;
}

/** Stub `fetch` and return the URLs POSTed to. */
function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ tokens: null }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ConvexAuthNextjsProvider under ConvexAuthNextjsServerStateProvider", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("hydrates with the access token the server provider read", async () => {
    let token: string | null | undefined;
    function Probe() {
      token = useAuthToken();
      return null;
    }
    render(
      <ConvexAuthNextjsServerStateProvider initialToken={bundle.accessToken}>
        <ConvexAuthNextjsProvider
          client={makeConvexClient()}
          storage={new InMemoryStorage()}
        >
          <Probe />
        </ConvexAuthNextjsProvider>
      </ConvexAuthNextjsServerStateProvider>,
    );
    await waitFor(() => expect(token).toBe(bundle.accessToken));
  });

  test("an explicit initialToken prop wins over the server state", async () => {
    let token: string | null | undefined;
    let isLoading = true;
    function Probe() {
      token = useAuthToken();
      ({ isLoading } = useConvexAuth());
      return null;
    }
    render(
      <ConvexAuthNextjsServerStateProvider initialToken={bundle.accessToken}>
        <ConvexAuthNextjsProvider
          client={makeConvexClient()}
          storage={new InMemoryStorage()}
          initialToken={null}
        >
          <Probe />
        </ConvexAuthNextjsProvider>
      </ConvexAuthNextjsServerStateProvider>,
    );
    // Read after init, since that is when the server state would be adopted.
    await waitFor(() => expect(isLoading).toBe(false));
    expect(token).toBeNull();
  });

  test("starts signed out without a server provider", async () => {
    let token: string | null | undefined;
    let isLoading = true;
    function Probe() {
      token = useAuthToken();
      ({ isLoading } = useConvexAuth());
      return null;
    }
    render(
      <ConvexAuthNextjsProvider
        client={makeConvexClient()}
        storage={new InMemoryStorage()}
      >
        <Probe />
      </ConvexAuthNextjsProvider>,
    );
    await waitFor(() => expect(isLoading).toBe(false));
    expect(token).toBeNull();
  });

  test("posts to the routes the server provider names", async () => {
    const fetchMock = stubFetch();
    let signOut!: ReturnType<typeof useAuthActions>["signOut"];
    function Probe() {
      ({ signOut } = useAuthActions());
      return null;
    }
    render(
      <ConvexAuthNextjsServerStateProvider
        initialToken={bundle.accessToken}
        signOutRoute="/api/auth/signout"
      >
        <ConvexAuthNextjsProvider
          client={makeConvexClient()}
          storage={new InMemoryStorage()}
        >
          <Probe />
        </ConvexAuthNextjsProvider>
      </ConvexAuthNextjsServerStateProvider>,
    );

    await signOut();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/signout");
  });
});
