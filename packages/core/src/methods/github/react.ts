/**
 * React client for the GitHub sign-in method, exported at
 * `@convex-dev/auth/methods/github/react`.
 *
 * {@link useSignInWithGithub} starts the sign-in, finishes the flow that the
 * page URL returns to when it mounts, and returns the error of GitHub's last
 * flow. {@link useOauth} returns the state that is shared by all the OAuth
 * methods, for example the error of the last flow of any of them. Call
 * {@link useOauthCallback} at the root of the app when the sign-in form
 * renders only after loading finishes.
 *
 * ```tsx
 * const { signIn, flowError } = useSignInWithGithub(api.auth);
 * ```
 *
 * @module
 */
"use client";

import type { OauthProviderApi } from "../oauth/client.ts";
import { useOauthSignIn, type UseOauthSignInReturn } from "../oauth/react.ts";

export {
  useOauth,
  useOauthCallback,
  type UseOauthReturn,
} from "../oauth/react.ts";
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
  /**
   * Why GitHub's last flow failed after the redirect back, or `null`. See
   * {@link UseOauthSignInReturn.flowError}.
   */
  flowError: UseOauthSignInReturn["flowError"];
};

/**
 * Sign in with GitHub. Pass the module exporting the provider's functions
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithGithub(api: {
  startSignInWithGithub: OauthProviderApi["startSignIn"];
  completeSignInWithGithub: OauthProviderApi["completeSignIn"];
}): UseSignInWithGithubReturn {
  const { signIn, flowError } = useOauthSignIn({
    providerName: "github",
    startSignIn: api.startSignInWithGithub,
    completeSignIn: api.completeSignInWithGithub,
  });
  return { signIn, flowError };
}
