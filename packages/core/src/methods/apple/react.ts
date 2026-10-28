/**
 * React client for the Apple sign-in method, exported at
 * `@convex-dev/auth/methods/apple/react`.
 *
 * {@link useSignInWithApple} starts the sign-in, finishes the flow that the
 * page URL returns to when it mounts, and returns the error of Apple's last
 * flow. {@link useOauth} returns the state that is shared by all the OAuth
 * methods, for example the error of the last flow of any of them. Call
 * {@link useOauthCallback} at the root of the app when the sign-in form
 * renders only after loading finishes.
 *
 * ```tsx
 * const { signIn, flowError } = useSignInWithApple(api.auth);
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

/** What {@link useSignInWithApple} returns. */
export type UseSignInWithAppleReturn = {
  /** Start Apple's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signIn: UseOauthSignInReturn["signIn"];
  /**
   * Why Apple's last flow failed after the redirect back, or `null`. See
   * {@link UseOauthSignInReturn.flowError}.
   */
  flowError: UseOauthSignInReturn["flowError"];
};

/**
 * Sign in with Apple. Pass the module exporting the provider's functions
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithApple(api: {
  startSignInWithApple: OauthProviderApi["startSignIn"];
  completeSignInWithApple: OauthProviderApi["completeSignIn"];
}): UseSignInWithAppleReturn {
  const { signIn, flowError } = useOauthSignIn({
    providerName: "apple",
    startSignIn: api.startSignInWithApple,
    completeSignIn: api.completeSignInWithApple,
  });
  return { signIn, flowError };
}
