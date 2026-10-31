/**
 * React client for the WorkOS sign-in method, exported at
 * `@convex-dev/auth/methods/workos/react`.
 *
 * {@link useSignInWithWorkos} starts an SSO sign-in, routed to an
 * organization or a connection. {@link useOauth} returns the state that is
 * shared by all the OAuth methods, for example the error of the last flow.
 *
 * ```tsx
 * const { signIn } = useSignInWithWorkos(api.auth);
 * const { flowError } = useOauth();
 *
 * await signIn({ organizationId: "org_...", loginHint: "ada@example.com" });
 * ```
 *
 * In a native iOS app, open the `redirect` URL in an
 * `ASWebAuthenticationSession`, not a web view: Google and Microsoft identity
 * providers refuse to sign in inside an embedded web view.
 *
 * @module
 */
"use client";

import { useMemo } from "react";
import type {
  OauthCompleteResult,
  OauthProviderApi,
  OauthStartResult,
  SignInOptions,
} from "../oauth/client.ts";
import { useOauthSignIn } from "../oauth/react.ts";
import type { WorkosRouting } from "./server.ts";

export type { WorkosRouting };
export { useOauth, type UseOauthReturn } from "../oauth/react.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthStartResult,
  SignInOptions,
} from "../oauth/client.ts";

/** What starting a WorkOS sign-in takes. */
export type WorkosSignInOptions = Omit<SignInOptions, "code" | "startArgs"> &
  WorkosRouting & { code?: undefined };

/** What {@link useSignInWithWorkos} returns. */
export type UseSignInWithWorkosReturn = {
  /**
   * Start an SSO sign-in routed by the {@link WorkosRouting} fields (exactly
   * one of `organizationId` and `connectionId`), or, with `code`, finish one
   * started elsewhere. See `useOauthSignIn`.
   */
  signIn: {
    (options: SignInOptions & { code: string }): Promise<OauthCompleteResult>;
    (options: WorkosSignInOptions): Promise<OauthStartResult>;
  };
};

/**
 * Sign in with WorkOS SSO. Pass the module exporting the functions of the
 * method (usually the generated `api.auth`), or an object mapping the
 * canonical keys to renamed exports.
 */
export function useSignInWithWorkos(api: {
  startSignInWithWorkos: OauthProviderApi["startSignIn"];
  completeSignInWithWorkos: OauthProviderApi["completeSignIn"];
}): UseSignInWithWorkosReturn {
  const { signIn: oauthSignIn } = useOauthSignIn({
    providerName: "workos",
    startSignIn: api.startSignInWithWorkos,
    completeSignIn: api.completeSignInWithWorkos,
  });
  const signIn = useMemo(() => {
    function signIn(
      options: SignInOptions & { code: string },
    ): Promise<OauthCompleteResult>;
    function signIn(options: WorkosSignInOptions): Promise<OauthStartResult>;
    function signIn(
      options: (SignInOptions & { code: string }) | WorkosSignInOptions,
    ): Promise<OauthCompleteResult | OauthStartResult> {
      if (options.code !== undefined) {
        return oauthSignIn({
          redirectTo: options.redirectTo,
          code: options.code,
        });
      }
      const { organizationId, connectionId, loginHint, domainHint } = options;
      const startArgs: Record<string, string> = {};
      if (organizationId !== undefined)
        startArgs.organizationId = organizationId;
      if (connectionId !== undefined) startArgs.connectionId = connectionId;
      if (loginHint !== undefined) startArgs.loginHint = loginHint;
      if (domainHint !== undefined) startArgs.domainHint = domainHint;
      return oauthSignIn({ redirectTo: options.redirectTo, startArgs });
    }
    return signIn;
  }, [oauthSignIn]);
  return { signIn };
}
