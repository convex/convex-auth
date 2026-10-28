/**
 * React client for the Google sign-in method, exported at
 * `@convex-dev/auth/methods/google/react`.
 *
 * {@link useSignInWithGoogle} starts the sign-in, and finishes the flow that the
 * page URL returns to when it mounts. {@link useOauth} returns the state that
 * is shared by all the OAuth methods, for example the error of the last flow.
 * Call {@link useOauthCallback} at the root of the app when the sign-in form
 * renders only after loading finishes.
 *
 * ```tsx
 * const { signIn } = useSignInWithGoogle(api.auth);
 * const { flowError } = useOauth();
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

/** What {@link useSignInWithGoogle} returns. */
export type UseSignInWithGoogleReturn = {
  /** Start Google's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signIn: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with Google. Pass the module exporting the provider's functions
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithGoogle(api: {
  startSignInWithGoogle: OauthProviderApi["startSignIn"];
  completeSignInWithGoogle: OauthProviderApi["completeSignIn"];
}): UseSignInWithGoogleReturn {
  const { signIn } = useOauthSignIn({
    providerName: "google",
    startSignIn: api.startSignInWithGoogle,
    completeSignIn: api.completeSignInWithGoogle,
  });
  return { signIn };
}
