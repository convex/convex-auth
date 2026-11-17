/**
 * The step that the password sign-in flows share: run a mutation that mints
 * a session, and hand the session to the `AuthClient`.
 *
 * @module
 */

import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { AuthSignInApi, SignInFunction } from "./ambientSignInClient.ts";
import type { AuthClient } from "./sessionManager.ts";

/**
 * The mutation threw rather than resolving to a `userError`. The thrown
 * value is preserved on `cause`.
 */
export type SignInUnexpectedFailure = {
  status: "error";
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * Run `fn` through the `AuthSignInApi` and, when it completes, hand the
 * session to the `AuthClient`. A thrown error comes back as `OTHER_ERROR`,
 * so the caller handles every failure through the one `userError` switch,
 * and can still inspect or log the thrown value on `cause`.
 */
export async function runSignInMutation<F extends SignInFunction<"mutation">>(
  options: {
    authClient: Pick<AuthClient, "setSession">;
    signInApi: AuthSignInApi;
  },
  fn: F,
  args: FunctionArgs<F>,
): Promise<FunctionReturnType<F> | SignInUnexpectedFailure> {
  try {
    const result = await options.signInApi.mutation(fn, args);
    if (result.status === "complete") {
      await options.authClient.setSession(result.tokens);
    }
    return result;
  } catch (cause) {
    return { status: "error", userError: { error: "OTHER_ERROR", cause } };
  }
}
