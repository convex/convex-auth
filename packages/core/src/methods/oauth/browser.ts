/**
 * Framework-agnostic client for the OAuth methods (Google, Apple, GitHub),
 * exported at `@convex-dev/auth/methods/oauth/browser`. The React hooks of
 * `@convex-dev/auth/methods/oauth/react` read the same state, and a binding
 * for another framework can too.
 *
 * {@link oauth} is the ambient sign-in that finishes a flow when the identity
 * provider sends the user back. A binding registers it in the
 * `ambientSignIns` of its `AuthClient` (the React providers do by default).
 * {@link createOauthState} reads the state it publishes, and the
 * `createSignInWith<Provider>` factories of
 * `@convex-dev/auth/methods/<provider>/browser` start a flow.
 *
 * ```ts
 * import type { AuthClient } from "@convex-dev/auth/browser";
 * import { createOauthState } from "@convex-dev/auth/methods/oauth/browser";
 *
 * // Made with `ambientSignIns: { signIns: [oauth()], … }` in its config.
 * declare const authClient: AuthClient;
 *
 * const { flowError } = createOauthState(authClient);
 * flowError.subscribe(() => {
 *   // switch on flowError.get()?.error and show a message
 * });
 * ```
 *
 * @module
 */

import type { AuthClient } from "../../browser/sessionManager.ts";
import type { ReadableStore } from "../../browser/store.ts";
import {
  OAUTH_ACTIONS_KEY,
  OAUTH_FLOW_ERROR_KEY,
  OAUTH_SETUP_ID,
  type OauthActions,
  type OauthCompleteResult,
  type OauthFlowError,
  type OauthProviderRefs,
  type OauthStartResult,
  type SignInOptions,
} from "./client.ts";

export { oauth } from "./client.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthProviderApi,
  OauthStartResult,
  SignInOptions,
} from "./client.ts";
export type { ReadableStore } from "../../browser/store.ts";

/** What every reader here throws when the OAuth setup published nothing. */
const NOT_REGISTERED_ERROR =
  "No OAuth setup is registered. Include oauth() from " +
  "@convex-dev/auth/methods/oauth/browser in the `ambientSignIns` of the " +
  "AuthClient. The React providers register it by default.";

/** The OAuth state that isn't tied to one provider. */
export type OauthState = {
  /**
   * Why the last flow failed after the redirect back, or `null`. Cleared on
   * the next sign-in. Switch on its `error` and supply the text for each
   * code.
   */
  flowError: ReadableStore<OauthFlowError | null>;
};

/** The `signIn` function of an OAuth provider. */
export type OauthSignIn = {
  /** Finish a flow started elsewhere with its callback `code`. */
  (options: SignInOptions & { code: string }): Promise<OauthCompleteResult>;
  /**
   * Start the provider's OAuth flow. Navigates away to the identity
   * provider on the web. A failure to start comes back in the result, and a
   * failure after the redirect back shows up in {@link OauthState.flowError}.
   */
  (
    options?: Omit<SignInOptions, "code"> & { code?: undefined },
  ): Promise<OauthStartResult>;
};

/** The client of one OAuth provider. */
export type OauthSignInClient = {
  /** Start (or, with a `code`, finish) the provider's OAuth flow. */
  signIn: OauthSignIn;
};

/**
 * Read the OAuth state that isn't tied to one provider. A flow completes on
 * whichever page it redirects back to, so `flowError` can appear on a page
 * that never started a sign-in.
 *
 * Throws when {@link oauth} is not registered on `authClient`.
 */
export function createOauthState(
  authClient: Pick<AuthClient, "ambientSignInValues">,
): OauthState {
  const values = authClient.ambientSignInValues(OAUTH_SETUP_ID);
  // The value is published at setup, so `undefined` means oauth() was never
  // registered.
  if (values.get(OAUTH_FLOW_ERROR_KEY) === undefined) {
    throw new Error(NOT_REGISTERED_ERROR);
  }
  return {
    flowError: {
      get: () =>
        values.get<OauthFlowError | null>(OAUTH_FLOW_ERROR_KEY) ?? null,
      subscribe: (listener) => values.subscribe(OAUTH_FLOW_ERROR_KEY, listener),
    },
  };
}

/**
 * Run one OAuth provider's sign-in flow from its function references. The
 * `createSignInWith<Provider>` factories call this with their own
 * references.
 *
 * Throws when {@link oauth} is not registered on `authClient`.
 *
 * @internal Not public until the API for custom OAuth providers is stable.
 */
export function createOauthSignIn(
  authClient: Pick<AuthClient, "ambientSignInValues">,
  refs: OauthProviderRefs,
): OauthSignInClient {
  const actions = authClient
    .ambientSignInValues(OAUTH_SETUP_ID)
    .get<OauthActions>(OAUTH_ACTIONS_KEY);
  if (actions === undefined) {
    throw new Error(NOT_REGISTERED_ERROR);
  }
  // One function serves both call shapes. The action picks the path from
  // whether `code` is set, and the result matches the shape called.
  const signIn = ((options?: SignInOptions) =>
    actions.signIn(refs, options)) as OauthSignIn;
  return { signIn };
}
