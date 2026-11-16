/**
 * Framework-agnostic client for the GitHub sign-in method, exported at
 * `@convex-dev/auth/methods/github/browser`. The React hook of
 * `@convex-dev/auth/methods/github/react` does the same, and a binding for
 * another framework can wrap this one.
 *
 * {@link createSignInWithGithub} starts the sign-in. The `oauth()` ambient
 * sign-in of `@convex-dev/auth/methods/oauth/browser` must be registered on
 * the `AuthClient`: it finishes the flow when GitHub sends the user back,
 * and its `createOauthState` reads the error of the last flow.
 *
 * @module
 */

import type { AuthClient } from "../../browser/sessionManager.ts";
import { createOauthSignIn, type OauthSignInClient } from "../oauth/browser.ts";
import type { OauthProviderApi } from "../oauth/client.ts";

export {
  createOauthState,
  type OauthCompleteResult,
  type OauthFlowError,
  type OauthSignIn,
  type OauthSignInClient,
  type OauthStartResult,
  type OauthState,
  type SignInOptions,
} from "../oauth/browser.ts";

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
export function createSignInWithGithub(options: {
  /** The client that `oauth()` is registered on. */
  authClient: Pick<AuthClient, "ambientSignInValues">;
  /** The functions of the method, usually `api.auth`. */
  api: {
    startSignInWithGithub: OauthProviderApi["startSignIn"];
    completeSignInWithGithub: OauthProviderApi["completeSignIn"];
  };
}): OauthSignInClient {
  const { authClient, api } = options;
  return createOauthSignIn(authClient, {
    providerName: "github",
    startSignIn: api.startSignInWithGithub,
    completeSignIn: api.completeSignInWithGithub,
  });
}
