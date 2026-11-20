"use client";

import type { GenericId } from "convex/values";
import { useCallback, useContext, useState } from "react";
import type { SessionSwitchAction } from "../browser/sessionManager.ts";
import type {
  ClientView,
  ImpersonateUserFn,
  ImpersonateUserResult,
  SlimTokenBundle,
  StopImpersonatingFn,
  StopImpersonatingResult,
} from "../lib/types.ts";
import { AuthClientContext, useSwitchSignInApi } from "./client.tsx";
import { useStableFunctionReference } from "./functionReference.ts";

/**
 * A failure that the client reports itself, in the shape of the errors of the
 * backend:
 *
 *  * `SESSION_CHANGED`: the client moved to another session before this call
 *    could: another tab started or stopped an impersonation, or a sign-in or
 *    a sign-out completed. The client keeps that session. Usually nothing was
 *    sent. If the client moved while the call was under way, the backend ran
 *    it, and its session is not used.
 *  * `OTHER_ERROR`: the call threw. `cause` is what it threw.
 */
type ClientFailure = {
  status: "error";
  userError:
    { error: "SESSION_CHANGED" } | { error: "OTHER_ERROR"; cause: unknown };
};

/** What `impersonateUser` of {@link useImpersonation} resolves to. */
export type UseImpersonateUserResult =
  ClientView<ImpersonateUserResult> | ClientFailure;

/** What `stopImpersonating` of {@link useImpersonation} resolves to. */
export type UseStopImpersonatingResult =
  ClientView<StopImpersonatingResult> | ClientFailure;

/**
 * Start and stop an impersonation from the client: wire the backend's
 * `impersonateUser` and `stopImpersonating` mutations (see
 * `setupImpersonation`) to the core client.
 *
 * `impersonateUser` makes the client act as the given user. On success the
 * client moves to a session of that user: the Convex client authenticates
 * again, and every query runs again as that user. `stopImpersonating` moves
 * the client back to the impersonator's own session the same way. Both
 * resolve to an object with a `status` field: `"complete"`, or `"error"` with
 * a `userError` that says why.
 *
 * While the client moves between the two sessions, `useConvexAuth` reports
 * loading for a moment, so the app shows its `AuthLoading` content.
 *
 * Calls take turns, in this tab and across the tabs of the browser. A call
 * that waited is not sent if the call before it moved the client: it resolves
 * to `SESSION_CHANGED`. Disable your buttons while `pending` is `true`.
 *
 * To show who is being impersonated, subscribe to the backend's
 * `impersonation` query. It is `null` when the session is not an
 * impersonation.
 *
 * ```tsx
 * import { useImpersonation } from "@convex-dev/auth/react";
 * import { useQuery } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * function ImpersonationBanner() {
 *   const impersonation = useQuery(api.auth.impersonation);
 *   const { stopImpersonating, pending } = useImpersonation(api.auth);
 *   if (impersonation === undefined || impersonation === null) {
 *     return null;
 *   }
 *   return (
 *     <div role="status">
 *       You are acting as another user.
 *       <button onClick={() => void stopImpersonating()} disabled={pending}>
 *         Stop impersonating
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @param api The impersonation functions of the app, usually `api.auth`.
 */
export function useImpersonation<UsersTable extends string>(api: {
  impersonateUser: ImpersonateUserFn<UsersTable>;
  stopImpersonating: StopImpersonatingFn;
}) {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error(
      "useImpersonation must be used within a <ConvexAuthProvider> (or, " +
        "under Next.js, a <ConvexAuthNextjsProvider>).",
    );
  }
  const signInApi = useSwitchSignInApi();
  const impersonateUserMutation = useStableFunctionReference(
    api.impersonateUser,
  );
  const stopImpersonatingMutation = useStableFunctionReference(
    api.stopImpersonating,
  );
  const [pendingCalls, setPendingCalls] = useState(0);

  // Run a mutation that returns a session, and move the client to that
  // session. `switchSession` lets one such call run at a time, in this tab
  // and across tabs, and handles a refresh that crosses it.
  const switchSession = useCallback(
    async <Result extends { status: "complete" | "error" }>(
      mutate: () => Promise<Result>,
      actionOf: (result: Result) => SessionSwitchAction,
    ): Promise<Result | ClientFailure> => {
      setPendingCalls((count) => count + 1);
      try {
        const outcome = await authClient.switchSession(mutate, actionOf);
        return outcome.kind === "ran"
          ? outcome.result
          : { status: "error", userError: { error: "SESSION_CHANGED" } };
      } catch (cause) {
        // The mutation threw instead of resolving to a `userError`. Fold it
        // into the same result shape, as the hooks of the sign-in methods do.
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      } finally {
        setPendingCalls((count) => count - 1);
      }
    },
    [authClient],
  );

  const impersonateUser = useCallback(
    (userId: GenericId<UsersTable>): Promise<UseImpersonateUserResult> =>
      switchSession(
        () => signInApi.mutation(impersonateUserMutation, { userId }),
        (result) =>
          result.status === "complete"
            ? (result as unknown as { tokens: SlimTokenBundle }).tokens
            : null,
      ),
    [switchSession, signInApi, impersonateUserMutation],
  );

  const stopImpersonating = useCallback(
    (): Promise<UseStopImpersonatingResult> =>
      switchSession(
        () => signInApi.mutation(stopImpersonatingMutation, {}),
        (result) => {
          if (result.status === "complete") {
            return (result as unknown as { tokens: SlimTokenBundle }).tokens;
          }
          return result.userError.error === "IMPERSONATOR_SESSION_ENDED"
            ? "signOut"
            : null;
        },
      ),
    [switchSession, signInApi, stopImpersonatingMutation],
  );

  return {
    /**
     * Start acting as the user with the given id.
     *
     * Resolves to an object with a `status` field. If it is `"complete"`, the
     * client now acts as that user. If it is `"error"`, the `userError` field
     * says why: an error of the backend's `impersonateUser`, or
     * `SESSION_CHANGED` or `OTHER_ERROR` from the client.
     */
    impersonateUser,
    /**
     * Stop the impersonation, and go back to the impersonator's own session.
     *
     * Resolves to an object with a `status` field, like `impersonateUser`.
     * After `IMPERSONATOR_SESSION_ENDED` the client is signed out.
     */
    stopImpersonating,
    /** `true` while a call to either function is under way. */
    pending: pendingCalls > 0,
  };
}
