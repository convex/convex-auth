// @vitest-environment jsdom
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { ConvexReactClient, useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAuthClient } from "../browser/createAuthClient.ts";
import type { SignInFunction } from "../browser/signInApi.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
} from "../browser/storage.ts";
import { seedPendingFlow } from "../methods/oauth/testFlow.ts";
import {
  FakeWebSocket,
  openSocket,
  sentTypes,
  webSocketConstructor,
} from "./testWebSocket.ts";
import { useOauth, useOauthCallback } from "../methods/oauth/react.ts";
import { useAuthClient } from "./client.tsx";
import { ConvexAuthProvider } from "./index.tsx";

const URL = "https://happy-animal-123.convex.cloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
};

/**
 * A real Convex client against a fake deployment URL. Its websocket is a
 * {@link FakeWebSocket}, because the provider resumes it for a signed-out
 * user.
 */
function makeConvexClient(options: { expectAuth?: boolean } = {}) {
  return new ConvexReactClient(URL, { ...options, webSocketConstructor });
}

function makeAuth(
  convex = makeConvexClient(),
  storage = new InMemoryStorage(),
) {
  return createAuthClient({ convex, api: API, storage });
}

const SIGN_IN = makeFunctionReference<"mutation">(
  "auth:signInProbe",
) as unknown as SignInFunction<"mutation">;

/** Renders the OAuth flow error of the auth client. */
function OauthFlowError() {
  return <div>{String(useOauth().flowError)}</div>;
}

describe("ConvexAuthProvider", () => {
  test("useAuthClient returns the auth client inside the provider", () => {
    const auth = makeAuth();
    const { result } = renderHook(() => useAuthClient(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ConvexAuthProvider auth={auth}>{children}</ConvexAuthProvider>
      ),
    });
    expect(result.current).toBe(auth);
  });

  test("useAuthClient throws outside a provider", () => {
    expect(() => renderHook(() => useAuthClient())).toThrow(
      /useAuthClient must be used within a <ConvexAuthProvider>/,
    );
  });

  test("the provider renders the auth client's Convex client", () => {
    const convex = makeConvexClient();
    const auth = makeAuth(convex);
    const { result } = renderHook(() => useConvex(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ConvexAuthProvider auth={auth}>{children}</ConvexAuthProvider>
      ),
    });
    expect(result.current).toBe(convex);
  });

  test("setConvex renders the new Convex client", () => {
    const first = makeConvexClient();
    const second = makeConvexClient();
    const auth = makeAuth(first);
    const { result, rerender } = renderHook(() => useConvex(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ConvexAuthProvider auth={auth}>{children}</ConvexAuthProvider>
      ),
    });
    auth.setConvex(second);
    rerender();
    expect(result.current).toBe(second);
  });

  test("the sign-in api routes through the Convex client", async () => {
    const convex = makeConvexClient();
    const mutationSpy = vi
      .spyOn(convex, "mutation")
      .mockResolvedValue("result" as never);
    const auth = makeAuth(convex);
    await expect(auth.signIn.mutation(SIGN_IN, {})).resolves.toBe("result");
    expect(mutationSpy).toHaveBeenCalledWith(SIGN_IN, {});
  });

  test("the OAuth hooks work under the provider", () => {
    render(
      <ConvexAuthProvider auth={makeAuth()}>
        <OauthFlowError />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("null")).toBeDefined();
  });

  describe("over a websocket", () => {
    beforeEach(() => {
      FakeWebSocket.instances = [];
    });
    afterEach(() => {
      window.history.replaceState(null, "", "/");
    });

    test("a signed-out sign-in mutation is sent under expectAuth", async () => {
      const convex = makeConvexClient({ expectAuth: true });
      const auth = makeAuth(convex);
      render(
        <ConvexAuthProvider auth={auth}>
          <div />
        </ConvexAuthProvider>,
      );
      await waitFor(() => expect(auth.getSnapshot().isLoading).toBe(false));

      void auth.signIn.mutation(SIGN_IN, {});
      const socket = await openSocket();

      await waitFor(() => expect(sentTypes(socket)).toContain("Mutation"));
      void convex.close();
    });

    test("an OAuth callback code is redeemed under expectAuth", async () => {
      window.history.replaceState(null, "", "/?convexAuthCode=code-1");
      const storage = new InMemoryStorage();
      seedPendingFlow(storage);
      const convex = makeConvexClient({ expectAuth: true });
      const auth = makeAuth(convex, storage);
      function Callback() {
        useOauthCallback();
        return null;
      }
      render(
        <ConvexAuthProvider auth={auth}>
          <Callback />
        </ConvexAuthProvider>,
      );

      const socket = await openSocket();

      // The auth state reports loading until the code is redeemed, and the
      // redemption goes over the socket.
      await waitFor(() => expect(sentTypes(socket)).toContain("Mutation"));
      expect(auth.getSnapshot().isLoading).toBe(true);
      void convex.close();
    });

    test("a signed-in session sets auth once, through the Convex provider", async () => {
      const storage = new InMemoryStorage();
      const sessionStorage = new NamespacedStorage(storage, URL);
      sessionStorage.set(JWT_STORAGE_KEY, "access-0");
      sessionStorage.set(REFRESH_TOKEN_STORAGE_KEY, "refresh-0");
      const convex = makeConvexClient({ expectAuth: true });
      const auth = makeAuth(convex, storage);
      const setAuth = vi.spyOn(convex, "setAuth");
      render(
        <ConvexAuthProvider auth={auth}>
          <div />
        </ConvexAuthProvider>,
      );

      await waitFor(() => expect(setAuth).toHaveBeenCalled());
      // The Convex provider passes three arguments, and the resume passes two.
      expect(setAuth).toHaveBeenCalledOnce();
      expect(setAuth.mock.calls[0]).toHaveLength(3);
      void convex.close();
    });

    test("a signed-out sign-in mutation is sent without expectAuth", async () => {
      const convex = makeConvexClient();
      const auth = makeAuth(convex);
      render(
        <ConvexAuthProvider auth={auth}>
          <div />
        </ConvexAuthProvider>,
      );
      await waitFor(() => expect(auth.getSnapshot().isLoading).toBe(false));

      void auth.signIn.mutation(SIGN_IN, {});
      const socket = await openSocket();

      await waitFor(() => expect(sentTypes(socket)).toContain("Mutation"));
      void convex.close();
    });
  });
});
