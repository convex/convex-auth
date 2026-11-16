/**
 * React client for the Discord sign-in method, exported at
 * `@convex-dev/auth/methods/discord/react`.
 *
 * {@link useSignInWithDiscord} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * ```tsx
 * const { signIn } = useSignInWithDiscord(api.auth);
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

/** What {@link useSignInWithDiscord} returns. */
export type UseSignInWithDiscordReturn = {
  /** Start Discord's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signIn: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with Discord. Pass the module exporting the functions of the method
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithDiscord(api: {
  startSignInWithDiscord: OauthProviderApi["startSignIn"];
  completeSignInWithDiscord: OauthProviderApi["completeSignIn"];
}): UseSignInWithDiscordReturn {
  const { signIn } = useOauthSignIn({
    providerName: "discord",
    startSignIn: api.startSignInWithDiscord,
    completeSignIn: api.completeSignInWithDiscord,
  });
  return { signIn };
}
