/**
 * Svelte client for the `anonymous` method, the counterpart of `react.tsx`.
 *
 * @internal Not public until the anonymous sign-in method is ready: the
 * `exports` map of the package leaves it out, like the rest of the method.
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import {
  createSignInAnonymously,
  type SignInAnonymouslyMutation,
} from "./browser.ts";

export type { SignInAnonymouslyMutation } from "./browser.ts";

/**
 * Client for the anonymous method: run its `signInAnonymously` mutation and
 * hand the session it returns to the auth client. Call it during component
 * initialization, under `setupConvexAuth()` or `setupConvexAuthSvelteKit()`.
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInAnonymously(api: {
  signInAnonymously: SignInAnonymouslyMutation;
}): { signIn: () => Promise<void> } {
  const { authClient, signInApi } = getConvexAuthContext(
    "useSignInAnonymously()",
  );
  const { signIn } = createSignInAnonymously({ authClient, signInApi, api });
  return { signIn };
}
