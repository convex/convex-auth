/**
 * React client for the generic OAuth method, exported at
 * `@convex-dev/auth/methods/oauth/react`.
 *
 * {@link useOauthSignIn} runs the flow of an identity provider from its
 * function references. The Google, Apple and GitHub methods have their own
 * hooks, at `@convex-dev/auth/methods/<provider>/react`. {@link useOauth}
 * returns the state that isn't tied to one provider.
 *
 * {@link useOauthSignIn} and the per-provider hooks finish the flow that the
 * page URL returns to when they mount. The flow returns to the page that
 * started it, unless `redirectTo` names another page. The auth state reports
 * loading during the redemption only when the hook mounts in the page's first
 * render. So call {@link useOauthCallback} on a custom `redirectTo` page, and
 * at the root of the app when the sign-in form renders only after loading
 * finishes.
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
 * const { signIn } = useOauthSignIn({
 *   providerName: "acme",
 *   startSignIn: api.auth.startSignInAcme,
 *   completeSignIn: api.auth.completeSignInAcme,
 * });
 * const { flowError } = useOauth();
 * const result = await signIn();
 * if (result.status === "error") {
 *   switch (result.userError.error) {
 *     case "OTHER_ERROR": // ...
 *   }
 * }
 * ```
 *
 * @module
 */
"use client";

import { getFunctionName } from "convex/server";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuthClient } from "../../react/client.tsx";
import {
  completeOauthSignIn,
  handleOauthCallback,
  startOauthSignIn,
  type OauthCompleteResult,
  type OauthFlowError,
  type OauthProviderRefs,
  type OauthStartResult,
  type SignInOptions,
} from "./client.ts";
import { getOauthFlowError, subscribeOauthFlowError } from "./flowState.ts";

export type {
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
  const auth = useAuthClient();
  const subscribe = useCallback(
    (listener: () => void) => subscribeOauthFlowError(auth, listener),
    [auth],
  );
  const flowError = useSyncExternalStore(
    subscribe,
    () => getOauthFlowError(auth),
    () => null,
  );
  return { flowError };
}

/**
 * Finish the OAuth flow that the page URL returns to when the component
 * mounts, and return the flow error like {@link useOauth}. Use it on a custom
 * `redirectTo` page that renders no sign-in hook, and at the root of the app
 * when the sign-in hooks render only after loading finishes. The sign-in
 * hooks call it themselves.
 */
export function useOauthCallback(): UseOauthReturn {
  const auth = useAuthClient();
  useEffect(() => {
    handleOauthCallback(auth);
  }, [auth]);
  return useOauth();
}

/** What {@link useOauthSignIn} returns. */
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
  signIn: {
    (options: SignInOptions & { code: string }): Promise<OauthCompleteResult>;
    (
      options?: Omit<SignInOptions, "code"> & { code?: undefined },
    ): Promise<OauthStartResult>;
  };
};

/**
 * Run one OAuth provider's sign-in flow from its function references. The
 * per-provider hooks like `useSignInWithGoogle` call this with their
 * own references. It finishes the flow that the page URL returns to on mount,
 * through {@link useOauthCallback}.
 *
 * A failure while starting the flow comes back in the result. Failures after
 * the redirect back have no caller left to return to, so they are reported
 * through {@link useOauth}'s `flowError`.
 */
export function useOauthSignIn(refs: OauthProviderRefs): UseOauthSignInReturn {
  const auth = useAuthClient();
  useOauthCallback();
  // Generated api objects create a fresh reference object on every property
  // access, so the memo depends on the function paths instead. The `refs` it
  // captures can then be from an earlier render, which is fine because the
  // deps cover all three of its fields.
  const startPath = getFunctionName(refs.startSignIn);
  const completePath = getFunctionName(refs.completeSignIn);
  const { providerName } = refs;
  const signIn = useMemo(
    // One function serves both call shapes. It picks the path from whether
    // `code` is set, and the result matches the shape called.
    () =>
      ((options?: SignInOptions) =>
        options?.code !== undefined
          ? completeOauthSignIn(auth, options.code)
          : startOauthSignIn(
              auth,
              refs,
              options,
            )) as UseOauthSignInReturn["signIn"],
    [auth, providerName, startPath, completePath],
  );
  return { signIn };
}
