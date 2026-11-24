import { makeFunctionReference } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage, NamespacedStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import {
  createSendEmailMagicLink,
  createSignInWithEmailMagicLink,
} from "./browser.ts";

const NAMESPACE = "https://happy-animal-123.convex.cloud";
const SECRET_KEY = "__convexAuthEmailMagicLinkSecret";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};
const ref = makeFunctionReference<"mutation">("auth:flow") as never;
const api = { sendEmailMagicLink: ref, signInWithEmailMagicLink: ref };

/**
 * A real `AuthClient` over an in-memory storage, the mocks behind the
 * `AuthSignInApi` and the plain Convex client, and the secret as stored.
 */
function setup() {
  const storage = new InMemoryStorage();
  const authClient = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage,
    storageNamespace: NAMESPACE,
  });
  const runSignIn = vi.fn();
  const signInApi = {
    mutation: (_fn: unknown, args: unknown) => runSignIn(args),
  } as unknown as AuthSignInApi;
  const runMutation = vi.fn();
  const convex = {
    mutation: (_fn: unknown, args: unknown) => runMutation(args),
  } as never;
  const secrets = new NamespacedStorage(storage, NAMESPACE);
  return { authClient, signInApi, convex, runSignIn, runMutation, secrets };
}

/** Let the pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSendEmailMagicLink", () => {
  test("keeps the secret and strips it from the result", async () => {
    const options = setup();
    options.runMutation.mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const client = createSendEmailMagicLink({ ...options, api });

    const sending = client.sendMagicLink({ email: "ada@example.com" });
    expect(client.pending.get()).toBe(true);
    expect(await sending).toEqual({ success: true });
    expect(client.pending.get()).toBe(false);
    expect(options.runMutation).toHaveBeenCalledWith({
      email: "ada@example.com",
    });
    expect(options.secrets.get(SECRET_KEY)).toBe("secret-1");
    // Runs on the plain Convex client, never on the sign-in api.
    expect(options.runSignIn).not.toHaveBeenCalled();
  });

  test("returns a user error without storing a secret", async () => {
    const options = setup();
    const failure = { success: false, userError: { error: "RATE_LIMITED" } };
    options.runMutation.mockResolvedValue(failure);
    const client = createSendEmailMagicLink({ ...options, api });
    expect(await client.sendMagicLink({ email: "ada@example.com" })).toEqual(
      failure,
    );
    expect(options.secrets.get(SECRET_KEY)).toBeNull();
  });

  test("folds a thrown error into OTHER_ERROR", async () => {
    const options = setup();
    const cause = new Error("boom");
    options.runMutation.mockRejectedValue(cause);
    const client = createSendEmailMagicLink({ ...options, api });
    expect(await client.sendMagicLink({ email: "ada@example.com" })).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(client.pending.get()).toBe(false);
  });
});

describe("createSignInWithEmailMagicLink", () => {
  function make(options: ReturnType<typeof setup>) {
    return createSignInWithEmailMagicLink({
      ...options,
      api,
      emailCode: "code-1",
    });
  }

  test("waits for the auth client, then signs in and clears the secret", async () => {
    const options = setup();
    options.secrets.set(SECRET_KEY, "secret-1");
    let resolveMutation!: (value: unknown) => void;
    options.runSignIn.mockReturnValue(
      new Promise((resolve) => (resolveMutation = resolve)),
    );
    const flow = make(options);

    flow.start();
    await flush();
    // The auth client has not loaded yet.
    expect(options.runSignIn).not.toHaveBeenCalled();

    await options.authClient.init();
    await flush();
    expect(options.runSignIn).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
    // The auth state reports loading while the link is checked.
    expect(options.authClient.getSnapshot().isLoading).toBe(true);

    resolveMutation({ status: "complete", tokens: bundle });
    await flush();
    expect(flow.state.get()).toEqual({ status: "complete" });
    expect(options.secrets.get(SECRET_KEY)).toBeNull();
    expect(options.authClient.getSnapshot()).toMatchObject({
      isLoading: false,
      isAuthenticated: true,
    });
  });

  test("keeps the secret when the sign-in fails, so a newer link still works", async () => {
    const options = setup();
    options.secrets.set(SECRET_KEY, "secret-1");
    options.runSignIn.mockResolvedValue({
      status: "error",
      userError: { error: "INCORRECT_CODE" },
    });
    await options.authClient.init();
    const flow = make(options);

    flow.start();
    await flush();
    expect(flow.state.get()).toEqual({
      status: "error",
      userError: { error: "INCORRECT_CODE" },
    });
    expect(options.secrets.get(SECRET_KEY)).toBe("secret-1");
  });

  test("reports MISSING_SECRET in a browser that did not send the link", async () => {
    const options = setup();
    await options.authClient.init();
    const flow = make(options);

    flow.start();
    await flush();
    expect(flow.state.get()).toEqual({
      status: "error",
      userError: { error: "MISSING_SECRET" },
    });
    expect(options.runSignIn).not.toHaveBeenCalled();
  });
});
