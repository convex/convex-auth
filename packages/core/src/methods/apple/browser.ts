/**
 * Framework-agnostic client for the Apple sign-in method, exported at
 * `@convex-dev/auth/methods/apple/browser`. The React hook of
 * `@convex-dev/auth/methods/apple/react` does the same, and a binding for
 * another framework can wrap this one.
 *
 * {@link createSignInWithApple} starts the sign-in. The `oauth()` ambient
 * sign-in of `@convex-dev/auth/methods/oauth/browser` must be registered on
 * the `AuthClient`: it finishes the flow when Apple sends the user back,
 * and its `createOauthState` reads the error of the last flow.
 *
 * @module
 */

import type { AuthClient } from "../../browser/sessionManager.ts";
import {
  createOauthSignIn,
  type OauthSignIn,
  type OauthSignInClient,
  type SignInOptions,
} from "../oauth/browser.ts";
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
export function createSignInWithApple(options: {
  /** The client that `oauth()` is registered on. */
  authClient: Pick<AuthClient, "ambientSignInValues">;
  /** The functions of the method, usually `api.auth`. */
  api: {
    startSignInWithApple: OauthProviderApi["startSignIn"];
    completeSignInWithApple: OauthProviderApi["completeSignIn"];
  };
}): OauthSignInClient {
  // Like the other method clients, read the options when signing in, so a
  // binding can pass getters.
  const client = () =>
    createOauthSignIn(options.authClient, {
      providerName: "apple",
      startSignIn: options.api.startSignInWithApple,
      completeSignIn: options.api.completeSignInWithApple,
    });
  // Throw now when `oauth()` isn't registered.
  client();
  const signIn = (async (signInOptions?: SignInOptions) =>
    client().signIn(signInOptions as never)) as OauthSignIn;
  return { signIn };
}
