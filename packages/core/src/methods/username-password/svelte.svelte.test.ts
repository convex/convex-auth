import { makeFunctionReference } from "convex/server";
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import { mountHelper, watch } from "../../svelte/testing.svelte.fixture.ts";
import { useSignInWithUsernamePassword } from "./svelte.ts";

const api = {
  signInWithUsernamePassword: makeFunctionReference<"mutation">(
    "auth:signInWithUsernamePassword",
  ) as never,
};

const tokens = { accessToken: "access", refreshToken: "refresh" };

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const mutation = deferred<unknown>();
  const signInApi = {
    mutation: vi.fn(() => mutation.promise),
    action: vi.fn(),
  } as unknown as AuthSignInApi;
  const authClient = {
    setSession: vi.fn(async () => {}),
  } as unknown as AuthClient;
  const mounted = mountHelper({ authClient, signInApi }, () =>
    useSignInWithUsernamePassword(api),
  );
  return { ...mounted, mutation, signInApi, authClient };
}

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe("useSignInWithUsernamePassword", () => {
  it("runs the mutation, adopts the session, and tracks `pending`", async () => {
    const { result, mutation, signInApi, authClient, ...mounted } = setup();
    destroy = mounted.destroy;
    const pending = watch(() => result.pending);

    const signIn = result.signIn({ username: "ada", password: "secret" });
    flushSync();
    expect(signInApi.mutation).toHaveBeenCalledWith(
      api.signInWithUsernamePassword,
      { username: "ada", password: "secret" },
    );
    mutation.resolve({ status: "complete", tokens });

    expect(await signIn).toEqual({ status: "complete", tokens });
    flushSync();
    expect(authClient.setSession).toHaveBeenCalledWith(tokens);
    expect(pending.values).toEqual([false, true, false]);
    pending.stop();
  });

  it("folds a thrown error into OTHER_ERROR", async () => {
    const { result, mutation, authClient, ...mounted } = setup();
    destroy = mounted.destroy;
    const cause = new Error("offline");

    const signIn = result.signIn({ username: "ada", password: "secret" });
    mutation.reject(cause);

    expect(await signIn).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(authClient.setSession).not.toHaveBeenCalled();
    expect(result.pending).toBe(false);
  });

  it("throws in a component without the context of the bindings", () => {
    expect(() =>
      mountHelper(undefined, () => useSignInWithUsernamePassword(api)),
    ).toThrow(
      "useSignInWithUsernamePassword() must be called in a component that calls setupConvexAuth()",
    );
  });
});
