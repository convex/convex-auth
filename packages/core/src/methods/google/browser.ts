/**
 * Framework-agnostic client for the Google sign-in method, exported at
 * `@convex-dev/auth/methods/google/browser`. The React hook of
 * `@convex-dev/auth/methods/google/react` wraps it, and a binding for another
 * framework can too.
 *
 * {@link createSignInWithGoogle} starts the sign-in. The `oauth()` ambient
 * sign-in of `@convex-dev/auth/methods/oauth/browser` must be registered on
 * the `AuthClient`: it finishes the flow when Google sends the user back,
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

/** The functions of the Google method, usually `api.auth`. */
export type SignInWithGoogleApi = {
  startSignInWithGoogle: OauthProviderApi["startSignIn"];
  completeSignInWithGoogle: OauthProviderApi["completeSignIn"];
};

/** @internal The references of the Google method, from its `api`. */
export const googleRefs = (api: SignInWithGoogleApi): OauthProviderRefs => ({
  providerName: "google",
  startSignIn: api.startSignInWithGoogle,
  completeSignIn: api.completeSignInWithGoogle,
});

/**
 * Make the client that signs in with Google. Pass the module exporting the
 * functions of the method (usually the generated `api.auth`), or an object
 * mapping the canonical keys to renamed exports.
 *
 * Throws when `oauth()` is not registered on `authClient`.
 *
 * ```ts
 * import type { AuthClient } from "@convex-dev/auth/browser";
 * import { createSignInWithGoogle } from "@convex-dev/auth/methods/google/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 *
 * const { signIn } = createSignInWithGoogle({ authClient, api: api.auth });
 *
 * async function onClick() {
 *   // Navigates away to Google.
 *   const result = await signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.cause);
 *   }
 * }
 * ```
 */
export function createSignInWithGoogle(
  options: OauthMethodOptions<SignInWithGoogleApi>,
): OauthSignInClient {
  return createOauthMethodSignIn(options, googleRefs);
}
