/**
 * Framework-agnostic client for the Apple sign-in method, exported at
 * `@convex-dev/auth/methods/apple/browser`. The React hook of
 * `@convex-dev/auth/methods/apple/react` wraps it, and a binding for another
 * framework can too.
 *
 * {@link createSignInWithApple} starts the sign-in. The `oauth()` ambient
 * sign-in of `@convex-dev/auth/methods/oauth/browser` must be registered on
 * the `AuthClient`: it finishes the flow when Apple sends the user back,
 * and its `createOauthState` reads the error of the last flow. The types
 * of the results are exported there too.
 *
 * @module
 */

import type { OauthProviderApi, OauthProviderRefs } from "../oauth/client.ts";
import {
  createOauthMethodSignIn,
  type OauthMethodOptions,
  type OauthSignInClient,
} from "../oauth/browser.ts";

/** The functions of the Apple method, usually `api.auth`. */
export type SignInWithAppleApi = {
  startSignInWithApple: OauthProviderApi["startSignIn"];
  completeSignInWithApple: OauthProviderApi["completeSignIn"];
};

/** @internal The references of the Apple method, from its `api`. */
export const appleRefs = (api: SignInWithAppleApi): OauthProviderRefs => ({
  providerName: "apple",
  startSignIn: api.startSignInWithApple,
  completeSignIn: api.completeSignInWithApple,
});

/**
 * Make the client that signs in with Apple. Pass the module exporting the
 * functions of the method (usually the generated `api.auth`), or an object
 * mapping the canonical keys to renamed exports.
 *
 * Throws when `oauth()` is not registered on `authClient`.
 *
 * ```ts
 * import type { AuthClient } from "@convex-dev/auth/browser";
 * import { createSignInWithApple } from "@convex-dev/auth/methods/apple/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 *
 * const { signIn } = createSignInWithApple({ authClient, api: api.auth });
 *
 * async function onClick() {
 *   // Navigates away to Apple.
 *   const result = await signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.cause);
 *   }
 * }
 * ```
 */
export function createSignInWithApple(
  options: OauthMethodOptions<SignInWithAppleApi>,
): OauthSignInClient {
  return createOauthMethodSignIn(options, appleRefs);
}
