/**
 * Svelte client for the OAuth state that the Google, Apple, GitHub and
 * Discord methods share, exported at `@convex-dev/auth/methods/oauth/svelte`:
 * the counterpart of `@convex-dev/auth/methods/oauth/react`.
 *
 * `setupConvexAuth` and `setupConvexAuthSvelteKit` register {@link oauth} by
 * default, which finishes a flow when the identity provider redirects back to
 * the app. If you set their `ambientSignIns` option, include `oauth()`
 * yourself. Each provider has its own helper, at
 * `@convex-dev/auth/methods/<provider>/svelte`.
 *
 * Under SvelteKit, add each provider's `completeSignIn*` function to the
 * `signIn` list of `setupConvexAuthServer`. Its `startSignIn*` function runs
 * on the Convex client and is not listed.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import { fromReadableStore } from "../../svelte/store.ts";
import { createOauthState, type OauthSignIn } from "./browser.ts";
import type { OauthFlowError } from "./client.ts";

export { oauth } from "./client.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthProviderApi,
  OauthProviderRefs,
  OauthStartResult,
  SignInOptions,
} from "./client.ts";

/** What {@link useOauth} returns. */
export type UseOauthReturn = {
  /**
   * Why the last flow failed after the redirect back, or `null`. Cleared on
   * the next sign-in. Switch on its `error` and supply the text for each code.
   */
  readonly flowError: OauthFlowError | null;
};

/**
 * Read the OAuth state that isn't tied to one provider. A flow completes on
 * whichever page it redirects back to, so `flowError` can appear on a page
 * that never started a sign-in. Call it during component initialization, and
 * read `flowError` from the returned object.
 *
 * ```ts
 * const oauthState = useOauth();
 * // In the template: {#if oauthState.flowError}…{/if}
 * console.log(oauthState.flowError?.error);
 * ```
 */
export function useOauth(): UseOauthReturn {
  const { authClient } = getConvexAuthContext("useOauth()");
  // Throws when oauth() was never registered.
  const flowError = fromReadableStore(createOauthState(authClient).flowError);
  return {
    get flowError() {
      return flowError.current;
    },
  };
}

/** What the sign-in helpers of the OAuth providers return. */
export type UseOauthSignInReturn = {
  /**
   * Start the provider's OAuth flow, which navigates away to the identity
   * provider. With `options.code`, finish a flow started elsewhere instead.
   *
   * A failure to start comes back in the result. Failures after the redirect
   * back show up in {@link useOauth}'s `flowError`.
   */
  signIn: OauthSignIn;
};
