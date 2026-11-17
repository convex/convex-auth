/**
 * Svelte client for the Apple sign-in method, exported at
 * `@convex-dev/auth/methods/apple/svelte`: the counterpart of
 * `@convex-dev/auth/methods/apple/react`.
 *
 * {@link useSignInWithApple} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * Under SvelteKit, add `api.auth.completeSignInWithApple` to the `signIn`
 * list of `setupConvexAuthServer`.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import type { UseOauthSignInReturn } from "../oauth/svelte.ts";
import { createSignInWithApple, type SignInWithAppleApi } from "./browser.ts";

export { useOauth, type UseOauthReturn } from "../oauth/svelte.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthStartResult,
  SignInOptions,
} from "../oauth/client.ts";

/** What {@link useSignInWithApple} returns. */
export type UseSignInWithAppleReturn = {
  /** Start Apple's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signIn: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with Apple. Call it during component initialization. Pass the
 * module exporting the functions of the method (usually `api.auth`), or an
 * object mapping the canonical keys to renamed exports.
 *
 * ```ts
 * import { useOauth, useSignInWithApple } from "@convex-dev/auth/methods/apple/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const apple = useSignInWithApple(api.auth);
 * const oauthState = useOauth();
 *
 * // The onclick of the "Continue with Apple" button. It navigates away to
 * // Apple. A failure after the redirect back is in `oauthState.flowError`.
 * async function onclick() {
 *   const result = await apple.signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 */
export function useSignInWithApple(
  api: SignInWithAppleApi,
): UseSignInWithAppleReturn {
  const { authClient } = getConvexAuthContext("useSignInWithApple()");
  // Throws when oauth() was never registered.
  return createSignInWithApple({ authClient, api });
}
