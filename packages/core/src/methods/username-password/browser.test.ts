import { makeFunctionReference } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { TokenBundle } from "../../lib/types.ts";
import {
  createSignInWithUsernamePassword,
  createSignUpWithUsernamePassword,
} from "./browser.ts";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};
const credentials = { username: "ada", password: "correct horse" };
const mutation = makeFunctionReference<"mutation">("auth:flow") as never;

function setup() {
  const run = vi.fn();
  const signInApi = {
    mutation: (_fn: unknown, args: unknown) => run(args),
    action: (_fn: unknown, args: unknown) => run(args),
  } as unknown as AuthSignInApi;
  const setSession = vi.fn(async () => {});
  return { run, signInApi, authClient: { setSession } };
}

describe.each([
  {
    name: "createSignInWithUsernamePassword",
    create: (options: ReturnType<typeof setup>) => {
      const client = createSignInWithUsernamePassword({
        ...options,
        api: { signInWithUsernamePassword: mutation },
      });
      return { call: client.signIn, pending: client.pending };
    },
  },
  {
    name: "createSignUpWithUsernamePassword",
    create: (options: ReturnType<typeof setup>) => {
      const client = createSignUpWithUsernamePassword({
        ...options,
        api: { signUpWithUsernamePassword: mutation },
      });
      return { call: client.signUp, pending: client.pending };
    },
  },
])("$name", ({ create }) => {
  test("adopts the minted session", async () => {
    const options = setup();
    options.run.mockResolvedValue({ status: "complete", tokens: bundle });
    const { call } = create(options);

    const result = await call(credentials);

    expect(result).toEqual({ status: "complete", tokens: bundle });
    expect(options.run).toHaveBeenCalledWith(credentials);
    expect(options.authClient.setSession).toHaveBeenCalledWith(bundle);
  });

  test("returns a user error without adopting a session", async () => {
    const options = setup();
    const failure = {
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    };
    options.run.mockResolvedValue(failure);
    const { call } = create(options);

    expect(await call(credentials)).toEqual(failure);
    expect(options.authClient.setSession).not.toHaveBeenCalled();
  });

  test("folds a thrown error into OTHER_ERROR", async () => {
    const options = setup();
    const cause = new Error("network down");
    options.run.mockRejectedValue(cause);
    const { call, pending } = create(options);

    expect(await call(credentials)).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(pending.get()).toBe(false);
  });

  test("is pending while the mutation runs, and notifies", async () => {
    const options = setup();
    let resolve!: (value: unknown) => void;
    options.run.mockReturnValue(new Promise((r) => (resolve = r)));
    const { call, pending } = create(options);
    const seen: boolean[] = [];
    pending.subscribe(() => seen.push(pending.get()));

    expect(pending.get()).toBe(false);
    const running = call(credentials);
    expect(pending.get()).toBe(true);

    resolve({ status: "complete", tokens: bundle });
    await running;
    expect(pending.get()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("each client keeps its own pending", async () => {
    const options = setup();
    options.run.mockReturnValue(new Promise(() => {}));
    const first = create(options);
    const second = create(options);

    void first.call(credentials);
    expect(first.pending.get()).toBe(true);
    expect(second.pending.get()).toBe(false);
  });
});
