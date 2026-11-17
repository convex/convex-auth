/**
 * Framework-agnostic client for the Discord sign-in method, exported at
 * `@convex-dev/auth/methods/discord/browser`. The React hook of
 * `@convex-dev/auth/methods/discord/react` wraps it, and a binding for another
 * framework can too.
 *
 * {@link createSignInWithDiscord} starts the sign-in. The `oauth()` ambient
 * sign-in of `@convex-dev/auth/methods/oauth/browser` must be registered on
 * the `AuthClient`: it finishes the flow when Discord sends the user back,
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

/** The functions of the Discord method, usually `api.auth`. */
export type SignInWithDiscordApi = {
  startSignInWithDiscord: OauthProviderApi["startSignIn"];
  completeSignInWithDiscord: OauthProviderApi["completeSignIn"];
};

/** @internal The references of the Discord method, from its `api`. */
export const discordRefs = (api: SignInWithDiscordApi): OauthProviderRefs => ({
  providerName: "discord",
  startSignIn: api.startSignInWithDiscord,
  completeSignIn: api.completeSignInWithDiscord,
});

/**
 * Make the client that signs in with Discord. Pass the module exporting the
 * functions of the method (usually the generated `api.auth`), or an object
 * mapping the canonical keys to renamed exports.
 *
 * Throws when `oauth()` is not registered on `authClient`.
 *
 * ```ts
 * import type { AuthClient } from "@convex-dev/auth/browser";
 * import { createSignInWithDiscord } from "@convex-dev/auth/methods/discord/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 *
 * const { signIn } = createSignInWithDiscord({ authClient, api: api.auth });
 *
 * async function onClick() {
 *   // Navigates away to Discord.
 *   const result = await signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.cause);
 *   }
 * }
 * ```
 */
export function createSignInWithDiscord(
  options: OauthMethodOptions<SignInWithDiscordApi>,
): OauthSignInClient {
  return createOauthMethodSignIn(options, discordRefs);
}
