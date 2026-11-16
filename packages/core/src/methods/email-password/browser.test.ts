import { makeFunctionReference } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage, NamespacedStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import {
  createCompleteChangeEmail,
  createCompletePasswordRecovery,
  createCompleteSignUpWithEmailPassword,
  createSignInWithEmailPassword,
  createSignUpWithEmailPassword,
  createStartChangeEmail,
  createStartPasswordRecovery,
} from "./browser.ts";

const NAMESPACE = "https://happy-animal-123.convex.cloud";
const SIGN_UP_SECRET_KEY = "__convexAuthEmailPasswordSignUpSecret";
const CHANGE_EMAIL_SECRET_KEY = "__convexAuthEmailPasswordChangeEmailSecret";
const RECOVERY_SECRET_KEY = "__convexAuthEmailPasswordRecoverySecret";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};
const ref = makeFunctionReference<"mutation">("auth:flow") as never;
const api = {
  signInWithEmailPassword: ref,
  signUpWithEmailPassword: ref,
  completeSignUpWithEmailPassword: ref,
  startPasswordRecovery: ref,
  completePasswordRecovery: ref,
  startChangeEmail: ref,
  completeChangeEmail: ref,
};

/**
 * A real `AuthClient` over an in-memory storage, the mocks behind the
 * `AuthSignInApi` and the plain Convex client, and the secrets as stored.
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

describe("createSignInWithEmailPassword", () => {
  const credentials = { email: "ada@example.com", password: "pw" };

  test("adopts the minted session and tracks pending", async () => {
    const { authClient, signInApi, runSignIn } = setup();
    runSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    const client = createSignInWithEmailPassword({
      authClient,
      signInApi,
      api,
    });
    const seen: boolean[] = [];
    client.pending.subscribe(() => seen.push(client.pending.get()));

    expect(await client.signIn(credentials)).toEqual({
      status: "complete",
      tokens: bundle,
    });
    expect(runSignIn).toHaveBeenCalledWith(credentials);
    expect(authClient.getAccessToken()).toBe("access-1");
    expect(seen).toEqual([true, false]);
  });

  test("folds a thrown error into OTHER_ERROR", async () => {
    const { authClient, signInApi, runSignIn } = setup();
    const cause = new Error("boom");
    runSignIn.mockRejectedValue(cause);
    const client = createSignInWithEmailPassword({
      authClient,
      signInApi,
      api,
    });
    expect(await client.signIn(credentials)).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(client.pending.get()).toBe(false);
  });
});

describe.each([
  {
    name: "createSignUpWithEmailPassword",
    key: SIGN_UP_SECRET_KEY,
    success: { success: true, browserSecret: "secret-1" },
    expected: { success: true },
    call: (options: ReturnType<typeof setup>) => {
      const client = createSignUpWithEmailPassword({ ...options, api });
      return {
        run: () => client.signUp({ email: "ada@example.com", password: "pw" }),
        pending: client.pending,
      };
    },
  },
  {
    name: "createStartPasswordRecovery",
    key: RECOVERY_SECRET_KEY,
    success: {
      success: true,
      browserSecret: "secret-1",
      sentTo: "ada@example.com",
    },
    expected: { success: true, sentTo: "ada@example.com" },
    call: (options: ReturnType<typeof setup>) => {
      const client = createStartPasswordRecovery({ ...options, api });
      return {
        run: () => client.startPasswordRecovery({ email: "Ada@example.com" }),
        pending: client.pending,
      };
    },
  },
  {
    name: "createStartChangeEmail",
    key: CHANGE_EMAIL_SECRET_KEY,
    success: { success: true, browserSecret: "secret-1" },
    expected: { success: true },
    call: (options: ReturnType<typeof setup>) => {
      const client = createStartChangeEmail({ ...options, api });
      return {
        run: () =>
          client.startChangeEmail({ newEmail: "b@x.com", currentPassword: "" }),
        pending: client.pending,
      };
    },
  },
])("$name", ({ key, success, expected, call }) => {
  test("keeps the secret and strips it from the result", async () => {
    const options = setup();
    options.runMutation.mockResolvedValue(success);
    const { run, pending } = call(options);

    const running = run();
    expect(pending.get()).toBe(true);
    expect(await running).toEqual(expected);
    expect(pending.get()).toBe(false);
    expect(options.secrets.get(key)).toBe("secret-1");
    // Runs on the plain Convex client, never on the sign-in api.
    expect(options.runSignIn).not.toHaveBeenCalled();
  });

  test("returns a user error without storing a secret", async () => {
    const options = setup();
    const failure = { success: false, userError: { error: "RATE_LIMITED" } };
    options.runMutation.mockResolvedValue(failure);
    const { run } = call(options);
    expect(await run()).toEqual(failure);
    expect(options.secrets.get(key)).toBeNull();
  });

  test("folds a thrown error into OTHER_ERROR", async () => {
    const options = setup();
    const cause = new Error("boom");
    options.runMutation.mockRejectedValue(cause);
    const { run, pending } = call(options);
    expect(await run()).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(pending.get()).toBe(false);
  });
});

describe("createCompleteSignUpWithEmailPassword", () => {
  function make(options: ReturnType<typeof setup>) {
    return createCompleteSignUpWithEmailPassword({
      ...options,
      api,
      emailCode: "code-1",
    });
  }

  test("waits for the auth client, then completes and clears the secret", async () => {
    const options = setup();
    options.secrets.set(SIGN_UP_SECRET_KEY, "secret-1");
    let resolveMutation!: (value: unknown) => void;
    options.runSignIn.mockReturnValue(
      new Promise((resolve) => (resolveMutation = resolve)),
    );
    const flow = make(options);
    const states: string[] = [];
    flow.state.subscribe(() => states.push(flow.state.get().status));

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
    // The auth state reports loading while the link is validated.
    expect(options.authClient.getSnapshot().isLoading).toBe(true);

    resolveMutation({ status: "complete", tokens: bundle });
    await flush();
    expect(flow.state.get()).toEqual({ status: "complete" });
    expect(states).toEqual(["complete"]);
    expect(options.secrets.get(SIGN_UP_SECRET_KEY)).toBeNull();
    expect(options.authClient.getSnapshot()).toMatchObject({
      isLoading: false,
      isAuthenticated: true,
    });
  });

  test("presents the link once, however often it starts", async () => {
    const options = setup();
    options.secrets.set(SIGN_UP_SECRET_KEY, "secret-1");
    options.runSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    await options.authClient.init();
    const flow = make(options);

    flow.start()();
    flow.start();
    await flush();
    expect(options.runSignIn).toHaveBeenCalledTimes(1);
  });

  test("the cleanup cancels a start that still waits", async () => {
    const options = setup();
    options.secrets.set(SIGN_UP_SECRET_KEY, "secret-1");
    const flow = make(options);

    const stop = flow.start();
    stop();
    await options.authClient.init();
    await flush();
    expect(options.runSignIn).not.toHaveBeenCalled();
    expect(flow.state.get()).toEqual({ status: "loading" });

    // A later start (a remount) presents the link.
    options.runSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    flow.start();
    await flush();
    expect(flow.state.get()).toEqual({ status: "complete" });
  });

  test("reports MISSING_SECRET in a browser that did not start the flow", async () => {
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

  test("a failed completion keeps the secret", async () => {
    const options = setup();
    options.secrets.set(SIGN_UP_SECRET_KEY, "secret-1");
    const userError = { error: "INCORRECT_CODE" };
    options.runSignIn.mockResolvedValue({ status: "error", userError });
    await options.authClient.init();
    const flow = make(options);
    flow.start();
    await flush();
    expect(flow.state.get()).toEqual({ status: "error", userError });
    expect(options.secrets.get(SIGN_UP_SECRET_KEY)).toBe("secret-1");
  });

  test("folds a thrown error into OTHER_ERROR", async () => {
    const options = setup();
    options.secrets.set(SIGN_UP_SECRET_KEY, "secret-1");
    const cause = new Error("boom");
    options.runSignIn.mockRejectedValue(cause);
    await options.authClient.init();
    const flow = make(options);
    flow.start();
    await flush();
    expect(flow.state.get()).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("reads the options when it starts", async () => {
    const options = setup();
    options.secrets.set(SIGN_UP_SECRET_KEY, "secret-1");
    options.runSignIn.mockResolvedValue({ status: "complete", tokens: bundle });
    let emailCode = "code-1";
    const flow = createCompleteSignUpWithEmailPassword({
      ...options,
      api,
      get emailCode() {
        return emailCode;
      },
    });
    flow.start();
    emailCode = "code-2";
    await options.authClient.init();
    await flush();
    expect(options.runSignIn).toHaveBeenCalledWith({
      emailCode: "code-2",
      browserSecret: "secret-1",
    });
  });
});

describe("createCompleteChangeEmail", () => {
  test("presents the link on the Convex client and clears the secret", async () => {
    const options = setup();
    options.secrets.set(CHANGE_EMAIL_SECRET_KEY, "secret-1");
    options.runMutation.mockResolvedValue({ success: true });
    await options.authClient.init();
    const flow = createCompleteChangeEmail({
      ...options,
      api,
      emailCode: "code-1",
    });
    flow.start();
    await flush();
    expect(options.runMutation).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
    expect(options.runSignIn).not.toHaveBeenCalled();
    expect(flow.state.get()).toEqual({ status: "complete" });
    expect(options.secrets.get(CHANGE_EMAIL_SECRET_KEY)).toBeNull();
  });

  test("reports the user error of the server", async () => {
    const options = setup();
    options.secrets.set(CHANGE_EMAIL_SECRET_KEY, "secret-1");
    const userError = { error: "EMAIL_TAKEN" };
    options.runMutation.mockResolvedValue({ success: false, userError });
    await options.authClient.init();
    const flow = createCompleteChangeEmail({
      ...options,
      api,
      emailCode: "code-1",
    });
    flow.start();
    await flush();
    expect(flow.state.get()).toEqual({ status: "error", userError });
  });
});

describe("createCompletePasswordRecovery", () => {
  async function ready(options = setup()) {
    options.secrets.set(RECOVERY_SECRET_KEY, "secret-1");
    await options.authClient.init();
    const flow = createCompletePasswordRecovery({
      ...options,
      api,
      emailCode: "code-1",
    });
    const progress = vi.fn();
    flow.progress.subscribe(progress);
    expect(flow.checkArgs()).toBe("skip");
    flow.start();
    await flush();
    return { options, flow, progress };
  }

  test("reads the secret, then hands out the check args", async () => {
    const { flow, progress } = await ready();
    expect(progress).toHaveBeenCalled();
    expect(flow.checkArgs()).toEqual({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
    expect(flow.stateFor(undefined)).toEqual({ status: "loading" });
    expect(flow.stateFor({ success: true })).toMatchObject({
      status: "ready",
      pending: false,
    });
    expect(
      flow.stateFor({
        success: false,
        userError: { error: "INVALID_CHALLENGE" },
      }),
    ).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });

  test("reports MISSING_SECRET without a secret", async () => {
    const options = setup();
    await options.authClient.init();
    const flow = createCompletePasswordRecovery({
      ...options,
      api,
      emailCode: "code-1",
    });
    flow.start();
    await flush();
    expect(flow.checkArgs()).toBe("skip");
    expect(flow.stateFor(undefined)).toEqual({
      status: "error",
      userError: { error: "MISSING_SECRET" },
    });
  });

  test("completes, adopts the session, and clears the secret", async () => {
    const { options, flow } = await ready();
    let resolveMutation!: (value: unknown) => void;
    options.runSignIn.mockReturnValue(
      new Promise((resolve) => (resolveMutation = resolve)),
    );
    const state = flow.stateFor({ success: true });
    if (state.status !== "ready") throw new Error("not ready");

    const running = state.completePasswordRecovery({ newPassword: "new" });
    // The claim of the link reaches the check before the result: the form
    // stays while the completion runs.
    expect(
      flow.stateFor({
        success: false,
        userError: { error: "INVALID_CHALLENGE" },
      }),
    ).toMatchObject({ status: "ready", pending: true });

    resolveMutation({ status: "complete", tokens: bundle });
    expect(await running).toEqual({ status: "complete", tokens: bundle });
    expect(options.runSignIn).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
      newPassword: "new",
    });
    expect(flow.stateFor(undefined)).toEqual({ status: "complete" });
    expect(options.secrets.get(RECOVERY_SECRET_KEY)).toBeNull();
    expect(options.authClient.getAccessToken()).toBe("access-1");
  });

  test("a password error keeps the state ready, a link error ends it", async () => {
    const { options, flow } = await ready();
    const passwordError = { error: "PASSWORD_TOO_SHORT" };
    options.runSignIn.mockResolvedValueOnce({
      status: "error",
      userError: passwordError,
    });
    expect(await flow.completePasswordRecovery({ newPassword: "x" })).toEqual({
      status: "error",
      userError: passwordError,
    });
    expect(flow.stateFor({ success: true })).toMatchObject({
      status: "ready",
    });

    const linkError = { error: "INCORRECT_CODE" };
    options.runSignIn.mockResolvedValueOnce({
      status: "error",
      userError: linkError,
    });
    await flow.completePasswordRecovery({ newPassword: "long enough" });
    expect(flow.stateFor({ success: true })).toEqual({
      status: "error",
      userError: linkError,
    });
    expect(options.secrets.get(RECOVERY_SECRET_KEY)).toBe("secret-1");
  });

  test("folds a thrown error into OTHER_ERROR", async () => {
    const { options, flow } = await ready();
    const cause = new Error("boom");
    options.runSignIn.mockRejectedValue(cause);
    expect(await flow.completePasswordRecovery({ newPassword: "new" })).toEqual(
      { status: "error", userError: { error: "OTHER_ERROR", cause } },
    );
    expect(flow.progress.get().pending).toBe(false);
  });

  test("throws when called before the secret is read", async () => {
    const options = setup();
    const flow = createCompletePasswordRecovery({
      ...options,
      api,
      emailCode: "code-1",
    });
    await expect(
      flow.completePasswordRecovery({ newPassword: "new" }),
    ).rejects.toThrow(/before the flow was ready/);
    expect(flow.progress.get().pending).toBe(false);
  });
});
