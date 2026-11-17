/**
 * The shared body of the passkey sign-in hook. Each entry point binds it to
 * the {@link ResolvedPasskeyCeremonies} of its platform. It wraps the
 * framework-agnostic {@link createSignInWithUsernamePasskey}.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useEffect, useMemo } from "react";
import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useMethodClient, useReadableStore } from "../../react/store.ts";
import type { ResolvedPasskeyCeremonies } from "./ceremonies.ts";
import type { UsernamePasskeyApi } from "./flows.ts";
import { createSignInWithUsernamePasskey } from "./signInClient.ts";

export type { SignInWithUsernamePasskeyResult } from "./signInClient.ts";

/**
 * The body of `useSignInWithUsernamePasskey`, for the given platform.
 *
 * @param usernamePasskeyApi The functions of the method, usually `api.auth`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useSignInWithUsernamePasskeyImpl(
  usernamePasskeyApi: UsernamePasskeyApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const { setSession } = useAuthActions();

  // Using useAuthSignInApi for mutations that return a session to support SSR
  const signInApi = useAuthSignInApi();
  const convex = useConvex();

  // One client per hook instance, so the pauses of its autofill flow hold
  // across a restart of the effect. It reads the arguments of the latest
  // render.
  const client = useMethodClient(createSignInWithUsernamePasskey, {
    authClient: { setSession },
    signInApi,
    convex,
    api: usernamePasskeyApi,
    ceremonies,
  });

  // While the hook is mounted, the autofill request runs. In StrictMode the
  // throwaway first mount's loop is stopped, and the second mount runs its
  // own loop.
  useEffect(() => client.startAutofill(), [client, ceremonies]);

  const pending = useReadableStore(client.pending);
  const autofill = useReadableStore(client.autofill);

  return useMemo(
    () => ({
      /**
       * Runs the identifier-first passkey flow for the given username.
       *
       * Returns an object with a `status` field.
       *
       * If it is `"complete"` the sign-in (or the account creation) was
       * successful and the client will establish an authenticated session
       * with the Convex backend server. The `flow` field tells which one
       * it was: `"signUp"` created a new account, `"signIn"` authenticated
       * an existing one.
       *
       * If it is `"error"` the returned object will have a `userError` field
       * with additional details about why sign-in failed.
       */
      signIn: client.signIn,
      /**
       * `true` while a sign-in runs: a `signIn` call, or an autofill
       * sign-in that the server verifies (`autofill.status` is
       * `"signingIn"`). A `signIn` call in this time returns
       * `ALREADY_PENDING`.
       */
      pending,
      /**
       * The state of the autofill flow:
       *
       * - `available`: whether the platform can offer passkeys in the
       *   autocompletion list; `null` while the detection runs.
       * - `status`: the state of the request; see
       *   {@link PasskeyAutofillStatus}.
       * - `lastError`: the most recent failure, for display or logging.
       */
      autofill,
    }),
    [client, pending, autofill],
  );
}
