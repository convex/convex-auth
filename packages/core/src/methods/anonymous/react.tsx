/**
 * React client for the `anonymous` method, exported at
 * `@convex-dev/auth/methods/anonymous/react`.
 *
 * A method's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession` (see
 * {@link useAuthActions}). The anonymous method is the simplest case. It
 * has a single mutation that directly returns the `TokenBundle`.
 *
 * It's useful as an example of the bare minimum a method needs on the
 * client: one hook, and no registration with the auth client at all.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useCallback } from "react";
import type { ClientView, SignInComplete } from "../../lib/types.ts";
import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";

/**
 * The `signInAnonymously` mutation the anonymous method adds to the app's API.
 *
 * Its bundle is the access-only {@link ClientView}, which is what both session
 * models have in common. Hand it to `setSession`, the only supported consumer.
 */
export type SignInAnonymouslyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  ClientView<SignInComplete>
>;

/**
 * Client for the anonymous method: wire its sign-in mutation to the core
 * client.
 *
 * The `signInAnonymously` mutation mints a session and returns a {@link
 * TokenBundle}; the hook feeds that bundle to `setSession` so the Convex
 * client authenticates. Passing a `TokenBundle` to `setSession` is the general
 * pattern that every sign-in method should follow.
 *
 * ```tsx
 * import { useSignInAnonymously } from "@convex-dev/auth/methods/anonymous/react";
 * import { api } from "../convex/_generated/api";
 *
 * function SignIn() {
 *   const { signIn } = useSignInAnonymously(api.auth);
 *   return <button onClick={() => signIn()}>Sign in anonymously</button>;
 * }
 * ```
 * When the `TokenBundle` is passed to `setSession`, that kicks off the
 * internal Convex auth machinery that authenticates the client with the
 * configured backend and re-renders components in an authenticated state.
 * Content within `<Authenticated>` helper components will render as will other
 * components that build on the authenticated state returned by
 * `useConvexAuthActions`.
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInAnonymously(api: {
  signInAnonymously: SignInAnonymouslyMutation;
}) {
  const signInMutation = useStableFunctionReference(api.signInAnonymously);
  const { setSession } = useAuthActions();
  // Running through the signInApi rather than `useMutation` is what lets this one
  // hook serve both session models. See {@link AuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const signIn = useCallback(async () => {
    const result = await signInApi.mutation(signInMutation, {});
    await setSession(result.tokens);
  }, [signInApi, signInMutation, setSession]);
  return { signIn };
}
