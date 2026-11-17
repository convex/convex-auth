/**
 * Svelte client for the Google sign-in method, exported at
 * `@convex-dev/auth/methods/google/svelte`: the counterpart of
 * `@convex-dev/auth/methods/google/react`.
 *
 * {@link useSignInWithGoogle} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * Under SvelteKit, add `api.auth.completeSignInWithGoogle` to the `signIn`
 * list of `setupConvexAuthServer`.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import type { UseOauthSignInReturn } from "../oauth/svelte.ts";
import { createSignInWithGoogle, type SignInWithGoogleApi } from "./browser.ts";

export { useOauth, type UseOauthReturn } from "../oauth/svelte.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthStartResult,
  SignInOptions,
} from "../oauth/client.ts";

/** What {@link useSignInWithGoogle} returns. */
export type UseSignInWithGoogleReturn = {
  /** Start Google's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signIn: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with Google. Call it during component initialization. Pass the
 * module exporting the functions of the method (usually `api.auth`), or an
 * object mapping the canonical keys to renamed exports.
 *
 * ```ts
 * import { useOauth, useSignInWithGoogle } from "@convex-dev/auth/methods/google/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const google = useSignInWithGoogle(api.auth);
 * const oauthState = useOauth();
 *
 * // The onclick of the "Continue with Google" button. It navigates away to
 * // Google. A failure after the redirect back is in `oauthState.flowError`.
 * async function onclick() {
 *   const result = await google.signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 */
export function useSignInWithGoogle(
  api: SignInWithGoogleApi,
): UseSignInWithGoogleReturn {
  const { authClient } = getConvexAuthContext("useSignInWithGoogle()");
  // Throws when oauth() was never registered.
  return createSignInWithGoogle({ authClient, api });
}
