import { makeFunctionReference } from "convex/server";
import { expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { createSignInAnonymously } from "./browser.ts";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

function setup() {
  const run = vi.fn();
  const signInApi = {
    mutation: (_fn: unknown, args: unknown) => run(args),
  } as unknown as AuthSignInApi;
  const setSession = vi.fn(async () => {});
  const client = createSignInAnonymously({
    authClient: { setSession },
    signInApi,
    api: {
      signInAnonymously: makeFunctionReference<"mutation">(
        "auth:signInAnonymously",
      ) as never,
    },
  });
  return { run, setSession, client };
}

test("adopts the minted session and tracks pending", async () => {
  const { run, setSession, client } = setup();
  let resolve!: (value: unknown) => void;
  run.mockReturnValue(new Promise((r) => (resolve = r)));
  const listener = vi.fn();
  client.pending.subscribe(listener);

  const running = client.signIn();
  expect(client.pending.get()).toBe(true);
  resolve({ status: "complete", tokens: bundle });
  await running;

  expect(run).toHaveBeenCalledWith({});
  expect(setSession).toHaveBeenCalledWith(bundle);
  expect(client.pending.get()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
});

test("rejects when the mutation throws, like the hook", async () => {
  const { run, setSession, client } = setup();
  run.mockRejectedValue(new Error("boom"));
  await expect(client.signIn()).rejects.toThrow("boom");
  expect(setSession).not.toHaveBeenCalled();
  expect(client.pending.get()).toBe(false);
});
