/**
 * Svelte client for the GitHub sign-in method, exported at
 * `@convex-dev/auth/methods/github/svelte`: the counterpart of
 * `@convex-dev/auth/methods/github/react`.
 *
 * {@link useSignInWithGithub} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * Under SvelteKit, add `api.auth.completeSignInWithGithub` to the `signIn`
 * list of `setupConvexAuthServer`.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import type { UseOauthSignInReturn } from "../oauth/svelte.ts";
import { createSignInWithGithub, type SignInWithGithubApi } from "./browser.ts";

export { useOauth, type UseOauthReturn } from "../oauth/svelte.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthStartResult,
  SignInOptions,
} from "../oauth/client.ts";

/** What {@link useSignInWithGithub} returns. */
export type UseSignInWithGithubReturn = {
  /** Start GitHub's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signIn: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with GitHub. Call it during component initialization. Pass the
 * module exporting the functions of the method (usually `api.auth`), or an
 * object mapping the canonical keys to renamed exports.
 *
 * ```ts
 * import { useOauth, useSignInWithGithub } from "@convex-dev/auth/methods/github/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const github = useSignInWithGithub(api.auth);
 * const oauthState = useOauth();
 *
 * // The onclick of the "Continue with GitHub" button. It navigates away to
 * // GitHub. A failure after the redirect back is in `oauthState.flowError`.
 * async function onclick() {
 *   const result = await github.signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 */
export function useSignInWithGithub(
  api: SignInWithGithubApi,
): UseSignInWithGithubReturn {
  const { authClient } = getConvexAuthContext("useSignInWithGithub()");
  // Throws when oauth() was never registered.
  return createSignInWithGithub({ authClient, api });
}
