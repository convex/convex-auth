/**
 * Framework-agnostic client for the `anonymous` method. The React hook of
 * `react.tsx` wraps it, and a binding for another framework can too.
 *
 * Not public until the anonymous sign-in method is ready: the `exports` map
 * of the package leaves it out, like the rest of the method.
 *
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import {
  createPendingTracker,
  type ReadableStore,
} from "../../browser/store.ts";
import type { ClientView, SignInComplete } from "../../lib/types.ts";

/**
 * The `signInAnonymously` mutation the anonymous method adds to the app's API.
 *
 * Its bundle is the access-only {@link ClientView}, which is what both session
 * models have in common.
 */
export type SignInAnonymouslyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  ClientView<SignInComplete>
>;

/** The client of the anonymous sign-in. */
export type SignInAnonymouslyClient = {
  /**
   * Mint an anonymous session and hand it to the `AuthClient`. Rejects when
   * the mutation throws.
   */
  signIn: () => Promise<void>;
  /** `true` while `signIn` runs. */
  pending: ReadableStore<boolean>;
};

/**
 * Make the client of the anonymous sign-in: run the `signInAnonymously`
 * mutation, and hand the session it returns to the `AuthClient`. That is the
 * bare minimum a method does on the client.
 */
export function createSignInAnonymously(options: {
  /** The client the session goes to. */
  authClient: Pick<AuthClient, "setSession">;
  /**
   * Runs the mutation. It mints a session, so under SSR it goes through the
   * auth proxy.
   */
  signInApi: AuthSignInApi;
  /** The functions of the method, usually `api.auth`. */
  api: { signInAnonymously: SignInAnonymouslyMutation };
}): SignInAnonymouslyClient {
  const { pending, track } = createPendingTracker();
  // The options are read when used, so a binding can pass getters.
  const signIn = () =>
    track(async () => {
      const result = await options.signInApi.mutation(
        options.api.signInAnonymously,
        {},
      );
      await options.authClient.setSession(result.tokens);
    });
  return { signIn, pending };
}
