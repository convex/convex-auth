/**
 * Svelte client for the Discord sign-in method, exported at
 * `@convex-dev/auth/methods/discord/svelte`: the counterpart of
 * `@convex-dev/auth/methods/discord/react`.
 *
 * {@link useSignInWithDiscord} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth methods, for example the error of the
 * last flow.
 *
 * Under SvelteKit, add `api.auth.completeSignInWithDiscord` to the `signIn`
 * list of `setupConvexAuthServer`.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import type { UseOauthSignInReturn } from "../oauth/svelte.ts";
import {
  createSignInWithDiscord,
  type SignInWithDiscordApi,
} from "./browser.ts";

export { useOauth, type UseOauthReturn } from "../oauth/svelte.ts";
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
 * Sign in with Discord. Call it during component initialization. Pass the
 * module exporting the functions of the method (usually `api.auth`), or an
 * object mapping the canonical keys to renamed exports.
 *
 * ```ts
 * import { useOauth, useSignInWithDiscord } from "@convex-dev/auth/methods/discord/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const discord = useSignInWithDiscord(api.auth);
 * const oauthState = useOauth();
 *
 * // The onclick of the "Continue with Discord" button. It navigates away to
 * // Discord. A failure after the redirect back is in `oauthState.flowError`.
 * async function onclick() {
 *   const result = await discord.signIn();
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 */
export function useSignInWithDiscord(
  api: SignInWithDiscordApi,
): UseSignInWithDiscordReturn {
  const { authClient } = getConvexAuthContext("useSignInWithDiscord()");
  // Throws when oauth() was never registered.
  return createSignInWithDiscord({ authClient, api });
}
