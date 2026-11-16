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
 * @internal Not public until the anonymous sign-in method is ready.
 * @module
 */
"use client";

import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useMethodClient } from "../../react/store.ts";
import {
  createSignInAnonymously,
  type SignInAnonymouslyMutation,
} from "./browser.ts";

export type { SignInAnonymouslyMutation } from "./browser.ts";

/**
 * Client for the anonymous method: wire its sign-in mutation to the core
 * client.
 *
 * The `signInAnonymously` mutation mints a session and returns a {@link
 * TokenBundle}; the hook feeds that bundle to `setSession` so the Convex
 * client authenticates. Passing a `TokenBundle` to `setSession` is the general
 * pattern that every sign-in method should follow.
 *
 * ```tsx skip-check
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
 * `useConvexAuth`.
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInAnonymously(api: {
  signInAnonymously: SignInAnonymouslyMutation;
}) {
  const { setSession } = useAuthActions();
  // Running through the signInApi rather than `useMutation` is what lets this one
  // hook serve both session models. See {@link useAuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const { signIn } = useMethodClient(createSignInAnonymously, {
    authClient: { setSession },
    signInApi,
    api,
  });
  return { signIn };
}
