import { vi } from "vitest";
import type { ConvexClientApi } from "../browser/signInApi.ts";
import type { AuthSignInApi } from "./client.tsx";

/**
 * A stub {@link AuthSignInApi} for tests, with the mock standing in for the Convex
 * call.
 *
 * Provider hooks run their sign-in function through `auth.signIn` rather than
 * calling `useMutation`/`useAction`, so tests build the auth client with this
 * sign-in API instead of mocking `convex/react`.
 */
export function stubSignInApi(): {
  signInApi: AuthSignInApi;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn();
  const signInApi = {
    mutation: (_fn: unknown, args: unknown) => run(args),
    action: (_fn: unknown, args: unknown) => run(args),
  } as unknown as AuthSignInApi;
  return { signInApi, run };
}

/**
 * A stand-in for the app's Convex client, for tests that never call it. Each
 * call rejects.
 */
export const unusedConvex: ConvexClientApi = {
  mutation: () => Promise.reject(new Error("unexpected Convex client call")),
  action: () => Promise.reject(new Error("unexpected Convex client call")),
};
