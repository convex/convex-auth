/**
 * Framework-agnostic client for the GitHub sign-in method, exported at
 * `@convex-dev/auth/methods/github/browser`. The React hook of
 * `@convex-dev/auth/methods/github/react` wraps it, and a binding for another
 * framework can too.
 *
 * {@link createSignInWithGithub} starts the sign-in. The `oauth()` ambient
 * sign-in of `@convex-dev/auth/methods/oauth/browser` must be registered on
 * the `AuthClient`: it finishes the flow when GitHub sends the user back,
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

/** The functions of the GitHub method, usually `api.auth`. */
export type SignInWithGithubApi = {
  startSignInWithGithub: OauthProviderApi["startSignIn"];
  completeSignInWithGithub: OauthProviderApi["completeSignIn"];
};

/** @internal The references of the GitHub method, from its `api`. */
export const githubRefs = (api: SignInWithGithubApi): OauthProviderRefs => ({
  providerName: "github",
  startSignIn: api.startSignInWithGithub,
  completeSignIn: api.completeSignInWithGithub,
});

/**
 * Make the client that signs in with GitHub. Pass the module exporting the
 * functions of the method (usually the generated `api.auth`), or an object
 * mapping the canonical keys to renamed exports.
 *
 * Throws when `oauth()` is not registered on `authClient`.
 *
 * ```ts
 * import type { AuthClient } from "@convex-dev/auth/browser";
 * import { createSignInWithGithub } from "@convex-dev/auth/methods/github/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 *
 * const { signIn } = createSignInWithGithub({ authClient, api: api.auth });
 *
 * async function onClick() {
 *   // Navigates away to GitHub.
 *   const result = await signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.cause);
 *   }
 * }
 * ```
 */
export function createSignInWithGithub(
  options: OauthMethodOptions<SignInWithGithubApi>,
): OauthSignInClient {
  return createOauthMethodSignIn(options, githubRefs);
}
