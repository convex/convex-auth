/**
 * React client for the Google sign-in method, exported at
 * `@convex-dev/auth/methods/google/react`.
 *
 * {@link useSignInWithGoogle} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * ```tsx
 * const { signIn } = useSignInWithGoogle(api.auth);
 * const { flowError } = useOauth();
 * ```
 *
 * @module
 */
"use client";

import { useOauthSignIn, type UseOauthSignInReturn } from "../oauth/react.ts";
import { googleRefs, type SignInWithGoogleApi } from "./browser.ts";

export { useOauth, type UseOauthReturn } from "../oauth/react.ts";
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
 * Sign in with Google. Pass the module exporting the functions of the method
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithGoogle(
  api: SignInWithGoogleApi,
): UseSignInWithGoogleReturn {
  return useOauthSignIn(googleRefs(api));
}
