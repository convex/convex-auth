// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryStorage } from "../../browser/storage.ts";
import { makeSlimBundle } from "../../lib/types.ts";
import { useSignInWithGithub } from "../../methods/github/react.ts";
import { useOauth, type OauthProviderApi } from "../../methods/oauth/react.ts";
import {
  NAMESPACE,
  bundle,
  restoreNavigatorProduct,
  seedPendingFlow,
  stubReactNative,
} from "../../methods/oauth/testFlow.ts";
import { useAuthToken } from "../../react/index.tsx";
import { ConvexAuthNextjsProvider } from "./client.tsx";

const githubApi = {
  startSignInWithGithub: makeFunctionReference<"mutation">(
    "auth:startSignInWithGithub",
  ) as OauthProviderApi["startSignIn"],
  completeSignInWithGithub: makeFunctionReference<"mutation">(
    "auth:completeSignInWithGithub",
  ) as OauthProviderApi["completeSignIn"],
};

const slim = makeSlimBundle(bundle);

/** Stub `fetch` so the sign-in proxy answers in the Convex HTTP format. */
function stubProxy(value: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ status: "success", value, logLines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * A real Convex client with mocked calls, so it never opens a socket. Calls
 * reject unless the test sets a result. `watchQuery` (used by the provider's
 * `SessionWatcher` subscription once a sign-in completes) is inert: it
 * reports no result and never updates.
 */
function makeConvexClient() {
  const client = new ConvexReactClient(NAMESPACE);
  const unexpected = new Error("unexpected Convex client call");
  const mutation = vi.spyOn(client, "mutation").mockRejectedValue(unexpected);
  vi.spyOn(client, "action").mockRejectedValue(unexpected);
  vi.spyOn(client, "setAuth").mockImplementation(() => {});
  vi.spyOn(client, "clearAuth").mockImplementation(() => {});
  vi.spyOn(client, "watchQuery").mockReturnValue({
    onUpdate: () => () => {},
    localQueryResult: () => undefined,
    localQueryLogs: () => undefined,
    journal: () => undefined,
  } as unknown as ReturnType<ConvexReactClient["watchQuery"]>);
  return { client, mutation };
}

describe("OAuth under ConvexAuthNextjsProvider", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("startSignIn runs on the Convex client, not the proxy", async () => {
    stubReactNative();
    const fetchMock = stubProxy(null);
    const { client, mutation } = makeConvexClient();
    mutation.mockResolvedValue({
      redirect: "https://github.com/login/oauth/authorize",
      state: "state-1",
    });
    let signInGithub!: ReturnType<typeof useSignInWithGithub>["signIn"];
    function Probe() {
      ({ signIn: signInGithub } = useSignInWithGithub(githubApi));
      return null;
    }
    render(
      <ConvexAuthNextjsProvider
        client={client}
        storage={new InMemoryStorage()}
        isAuthenticatedFunctionName="auth:isAuthenticated"
      >
        <Probe />
      </ConvexAuthNextjsProvider>,
    );

    await signInGithub({ redirectTo: "http://localhost/signin" });

    expect(mutation).toHaveBeenCalledWith(githubApi.startSignInWithGithub, {
      redirectTo: "http://localhost/signin",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a callback code redeems through the proxy and signs in", async () => {
    window.history.replaceState(null, "", "/signin?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, {
      providerName: "github",
      startSignIn: githubApi.startSignInWithGithub,
      completeSignIn: githubApi.completeSignInWithGithub,
    });
    const fetchMock = stubProxy({ status: "complete", tokens: slim });
    const { client, mutation } = makeConvexClient();
    let token: string | null = null;
    let flowError: unknown;
    function Probe() {
      token = useAuthToken();
      flowError = useOauth().flowError;
      return null;
    }
    render(
      <ConvexAuthNextjsProvider
        client={client}
        storage={storage}
        isAuthenticatedFunctionName="auth:isAuthenticated"
      >
        <Probe />
      </ConvexAuthNextjsProvider>,
    );

    await waitFor(() => expect(token).toBe(bundle.accessToken));
    expect(flowError).toBeNull();
    expect(mutation).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/auth/signin?path=/api/mutation");
    expect(JSON.parse(init.body as string)).toMatchObject({
      path: "auth:completeSignInWithGithub",
      args: [{ code: "code-1", state: "state-1" }],
    });
    expect(window.location.search).toBe("");
  });

  test("stripping the callback params also updates Next's router", async () => {
    // Next stores `__NA` in the history state of entries its router owns.
    window.history.replaceState(
      { __NA: true },
      "",
      "/signin?convexAuthCode=code-1",
    );
    const stripped = new URL("/signin", window.location.href).href;
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, {
      providerName: "github",
      startSignIn: githubApi.startSignInWithGithub,
      completeSignIn: githubApi.completeSignInWithGithub,
    });
    stubProxy({ status: "complete", tokens: slim });
    const { client } = makeConvexClient();
    const replaceState = vi.spyOn(window.history, "replaceState");
    render(
      <ConvexAuthNextjsProvider
        client={client}
        storage={storage}
        isAuthenticatedFunctionName="auth:isAuthenticated"
      >
        {null}
      </ConvexAuthNextjsProvider>,
    );

    // The first call strips the params and keeps Next's history state.
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenLastCalledWith({ __NA: true }, "", stripped);
    // The second call passes null state, so Next's patched replaceState
    // updates the router.
    await vi.waitFor(() =>
      expect(replaceState).toHaveBeenLastCalledWith(null, "", stripped),
    );
  });
});
