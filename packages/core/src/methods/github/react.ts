/**
 * React client for the GitHub sign-in method, exported at
 * `@convex-dev/auth/methods/github/react`.
 *
 * {@link useSignInWithGithub} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * ```tsx
 * const { signIn } = useSignInWithGithub(api.auth);
 * const { flowError } = useOauth();
 * ```
 *
 * @module
 */
"use client";

import { useOauthSignIn, type UseOauthSignInReturn } from "../oauth/react.ts";
import { githubRefs, type SignInWithGithubApi } from "./browser.ts";

export { useOauth, type UseOauthReturn } from "../oauth/react.ts";
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
 * Sign in with GitHub. Pass the module exporting the functions of the method
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithGithub(
  api: SignInWithGithubApi,
): UseSignInWithGithubReturn {
  return useOauthSignIn(githubRefs(api));
}
