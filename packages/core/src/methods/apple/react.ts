/**
 * React client for the Apple sign-in method, exported at
 * `@convex-dev/auth/methods/apple/react`.
 *
 * {@link useSignInWithApple} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * ```tsx
 * const { signIn } = useSignInWithApple(api.auth);
 * const { flowError } = useOauth();
 * ```
 *
 * @module
 */
"use client";

import type { OauthProviderApi } from "../oauth/client.ts";
import { useOauthSignIn, type UseOauthSignInReturn } from "../oauth/react.ts";

export { useOauth, type UseOauthReturn } from "../oauth/react.ts";
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
 * Sign in with Apple. Pass the module exporting the functions of the method
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithApple(api: {
  startSignInWithApple: OauthProviderApi["startSignIn"];
  completeSignInWithApple: OauthProviderApi["completeSignIn"];
}): UseSignInWithAppleReturn {
  const { signIn } = useOauthSignIn({
    providerName: "apple",
    startSignIn: api.startSignInWithApple,
    completeSignIn: api.completeSignInWithApple,
  });
  return { signIn };
}
