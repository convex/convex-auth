/**
 * React client for the shared OAuth state, exported at
 * `@convex-dev/auth/methods/oauth/react`.
 *
 * OAuth is registered by default in `ConvexAuthProvider` and
 * `ConvexAuthNextjsProvider`. If you set their `ambientSignIns` prop, include
 * {@link oauth} yourself. The Google, Apple, GitHub and Discord methods have
 * their own hooks, at `@convex-dev/auth/methods/<provider>/react`.
 * {@link useOauth} returns the state that isn't tied to one provider.
 *
 * Under Next.js, add each provider's `completeSignIn*` function to the auth
 * proxy's `signIn` allowlist. Its `startSignIn*` function runs on the Convex
 * client and is not listed.
 *
 * Errors come back as typed results for the app to switch on, as with the
 * password hooks. Starting a flow resolves to its result, and a failure after
 * the redirect back shows up in {@link useOauth}'s `flowError`.
 *
 * ```tsx
 * const { flowError } = useOauth();
 * ```
 *
 * @module
 */
"use client";

import { getFunctionName } from "convex/server";
import { useMemo } from "react";
import { useAuthClient } from "../../react/client.tsx";
import { useReadableStore } from "../../react/store.ts";
import {
  createOauthSignIn,
  createOauthState,
  type OauthSignIn,
} from "./browser.ts";
import type { OauthFlowError, OauthProviderRefs } from "./client.ts";

export { oauth } from "./client.ts";
export type {
  OauthActions,
  OauthCompleteResult,
  OauthFlowError,
  OauthProviderApi,
  OauthProviderRefs,
  OauthStartResult,
  SignInOptions,
} from "./client.ts";

/** What {@link useOauth} returns. */
export type UseOauthReturn = {
  /**
   * Why the last flow failed after the redirect back, or `null`. Cleared on
   * the next sign-in. Switch on its `error` and supply the text for each code.
   */
  flowError: OauthFlowError | null;
};

/**
 * Read OAuth state that isn't tied to one provider. A flow completes on
 * whichever page it redirects back to, so `flowError` can appear on a page
 * that never calls a sign-in hook. An app-level error banner can read it
 * here without any provider's function references.
 */
export function useOauth(): UseOauthReturn {
  const authClient = useAuthClient();
  // Throws when oauth() was never registered.
  const state = useMemo(() => createOauthState(authClient), [authClient]);
  return { flowError: useReadableStore(state.flowError) };
}

/** What the sign-in hooks of the OAuth providers return. */
export type UseOauthSignInReturn = {
  /**
   * Start the provider's OAuth flow (or, with `options.code`, complete one
   * started elsewhere). Navigates away to the identity provider on the web.
   * React Native isn't supported yet. It gets the `redirect` URL back to open
   * in an in-app browser, but `options.redirectTo` is required there and can
   * only be an http or https URL (see {@link SignInOptions}).
   *
   * Starting is declared last so `ReturnType` gives its result. Its `code` is
   * `undefined` so options that might hold a code match neither shape,
   * rather than being typed as a start that could finish a flow.
   */
  signIn: OauthSignIn;
};

/**
 * Run one OAuth provider's sign-in flow from its function references. The
 * per-provider hooks like `useSignInWithGoogle` call this with their
 * own references.
 *
 * A failure while starting the flow comes back in the result. Failures after
 * the redirect back have no caller left to return to, so they are reported
 * through {@link useOauth}'s `flowError`.
 *
 * ```tsx skip-check
 * const { signIn } = useOauthSignIn({
 *   providerName: "acme",
 *   startSignIn: api.auth.startSignInWithAcme,
 *   completeSignIn: api.auth.completeSignInWithAcme,
 * });
 * const result = await signIn();
 * if (result.status === "error") {
 *   switch (result.userError.error) {
 *     case "OTHER_ERROR": // ...
 *   }
 * }
 * ```
 *
 * @internal Not public until the API for custom OAuth providers is stable.
 */
export function useOauthSignIn(refs: OauthProviderRefs): UseOauthSignInReturn {
  const authClient = useAuthClient();
  // Generated api objects create a fresh reference object on every property
  // access, so the memo depends on the function paths instead. The `refs` it
  // captures can then be from an earlier render, which is fine because the
  // deps cover all three of its fields.
  const startPath = getFunctionName(refs.startSignIn);
  const completePath = getFunctionName(refs.completeSignIn);
  const { providerName } = refs;
  // Throws when oauth() was never registered.
  return useMemo(
    () => createOauthSignIn(authClient, refs),
    [authClient, providerName, startPath, completePath],
  );
}
