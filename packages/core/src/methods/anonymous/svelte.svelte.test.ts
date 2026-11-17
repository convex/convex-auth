import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import { mountHelper } from "../../svelte/testing.svelte.fixture.ts";
import { useSignInAnonymously } from "./svelte.ts";

const api = {
  signInAnonymously: makeFunctionReference<"mutation">(
    "auth:signInAnonymously",
  ) as never,
};

const tokens = { accessToken: "access", refreshToken: "refresh" };

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe("useSignInAnonymously", () => {
  it("runs the mutation and adopts the session", async () => {
    const signInApi = {
      mutation: vi.fn(async () => ({ status: "complete", tokens })),
      action: vi.fn(),
    } as unknown as AuthSignInApi;
    const authClient = {
      setSession: vi.fn(async () => {}),
    } as unknown as AuthClient;
    const mounted = mountHelper({ authClient, signInApi }, () =>
      useSignInAnonymously(api),
    );
    destroy = mounted.destroy;

    await mounted.result.signIn();

    expect(signInApi.mutation).toHaveBeenCalledWith(api.signInAnonymously, {});
    expect(authClient.setSession).toHaveBeenCalledWith(tokens);
  });

  it("throws in a component without the context of the bindings", () => {
    expect(() =>
      mountHelper(undefined, () => useSignInAnonymously(api)),
    ).toThrow(
      "useSignInAnonymously() must be called in a component that calls setupConvexAuth()",
    );
  });
});
