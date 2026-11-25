/**
 * Svelte client for the `emailMagicLink` method, exported at
 * `@convex-dev/auth/methods/email-magic-link/svelte`: the counterpart of
 * `@convex-dev/auth/methods/email-magic-link/react`.
 *
 * Sending the link keeps a secret in the storage of the browser, and the link
 * only works in that browser.
 *
 * Call every helper during component initialization. Read `pending` and
 * `current` from the returned objects (don't destructure them), so they stay
 * reactive. The helper of the landing page returns `{ current }`, where the
 * React hook returns the state itself.
 *
 * The helpers wrap the framework-agnostic clients of
 * `@convex-dev/auth/methods/email-magic-link/browser`.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import { landingPage, pendingOf } from "../../svelte/store.ts";
import {
  createSendEmailMagicLink,
  createSignInWithEmailMagicLink,
  type SendEmailMagicLinkMutation,
  type SendResult,
  type SignInState,
  type SignInWithEmailMagicLinkMutation,
} from "./browser.ts";

export type { SendResult, SignInState } from "./browser.ts";

/**
 * Send a sign-in link to the address. The same call serves a person who has
 * an account and a person who has none. The page that the link opens calls
 * {@link useSignInWithEmailMagicLink}.
 *
 * ```ts
 * import { useSendEmailMagicLink } from "@convex-dev/auth/methods/email-magic-link/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const magicLink = useSendEmailMagicLink(api.auth);
 *
 * async function onSubmit(email: string) {
 *   const result = await magicLink.sendMagicLink({ email });
 *   if (result.success) {
 *     // Tell the user to open the link in this browser.
 *   }
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSendEmailMagicLink(api: {
  sendEmailMagicLink: SendEmailMagicLinkMutation;
}): {
  /** Send the link. Resolves to a result, never rejects. */
  sendMagicLink: (args: { email: string }) => Promise<SendResult>;
  /** `true` while a link is being sent. */
  readonly pending: boolean;
} {
  const { authClient, convex } = getConvexAuthContext(
    "useSendEmailMagicLink()",
  );
  const client = createSendEmailMagicLink({ authClient, convex, api });
  return Object.assign(pendingOf(client.pending), {
    sendMagicLink: client.sendMagicLink,
  });
}

/**
 * Sign in from the link in the email. It runs on its own once the session
 * has loaded: render from `current`.
 *
 * ```ts
 * // The <script> of the page of the link. In SvelteKit, the code comes from
 * // `page.url.searchParams` of `$app/state`.
 * const emailCode = new URL(location.href).searchParams.get("code") ?? "";
 * const signIn = useSignInWithEmailMagicLink(api.auth, { emailCode });
 * // In the template: {#if signIn.current.status === "complete"}…{/if}
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useSignInWithEmailMagicLink(
  api: { signInWithEmailMagicLink: SignInWithEmailMagicLinkMutation },
  { emailCode }: { emailCode: string },
): { readonly current: SignInState } {
  const { authClient, signInApi } = getConvexAuthContext(
    "useSignInWithEmailMagicLink()",
  );
  return landingPage(
    createSignInWithEmailMagicLink({ authClient, signInApi, api, emailCode }),
  );
}
