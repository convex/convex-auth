import { vi } from "vitest";
import type { AuthSignInApi } from "./client.tsx";

/**
 * A stub {@link AuthSignInApi} for tests, with the mock standing in for the Convex
 * call.
 *
 * The hooks of the methods run their sign-in function through the signInApi rather than
 * calling `useMutation`/`useAction`, so tests substitute a signInApi instead of
 * mocking `convex/react`.
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
