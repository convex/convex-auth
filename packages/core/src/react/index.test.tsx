// @vitest-environment jsdom
import { render, renderHook, screen } from "@testing-library/react";
import { ConvexReactClient, useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createAuthClient } from "../browser/createAuthClient.ts";
import type { SignInFunction } from "../browser/signInApi.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import { useOauth } from "../methods/oauth/react.ts";
import { useAuthClient } from "./client.tsx";
import { ConvexAuthProvider } from "./index.tsx";

const URL = "https://happy-animal-123.convex.cloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
};

/**
 * A real Convex client against a fake deployment URL. Nothing here
 * authenticates or subscribes, so it never opens a connection.
 */
function makeConvexClient() {
  return new ConvexReactClient(URL);
}

function makeAuth(convex = makeConvexClient()) {
  return createAuthClient({ convex, api: API, storage: new InMemoryStorage() });
}

/**
 * Renders the flow error from the default oauth setup. The hook throws when
 * oauth() was never registered, so rendering this at all is the assertion.
 */
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
    const signIn = makeFunctionReference<"mutation">(
      "auth:signInProbe",
    ) as unknown as SignInFunction<"mutation">;
    const auth = makeAuth(convex);
    await expect(auth.signIn.mutation(signIn, {})).resolves.toBe("result");
    expect(mutationSpy).toHaveBeenCalledWith(signIn, {});
  });

  test("oauth() is registered by createAuthClient", () => {
    render(
      <ConvexAuthProvider auth={makeAuth()}>
        <OauthFlowError />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("null")).toBeDefined();
  });
});
