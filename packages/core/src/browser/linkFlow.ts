/**
 * The shared parts of the sign-in methods that finish with a link from an
 * email (email + password, magic link): the "start" mutation that keeps a
 * secret in `authClient.methodStorage`, and the landing page that presents
 * the link with that secret.
 *
 * @module
 */

import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import type { ConvexMutationApi } from "./ambientSignInClient.ts";
import type { AuthClient } from "./sessionManager.ts";
import {
  createPendingTracker,
  createStore,
  type ReadableStore,
} from "./store.ts";

/**
 * The mutation threw rather than resolving to a `userError`. The thrown value
 * is preserved on `cause`.
 */
export type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * A link was opened in a browser that did not start the flow: the flow's
 * secret is not in this browser's storage, so completion cannot proceed. Tell
 * the user to open the link in the browser they started from.
 */
export type MissingSecretError = { error: "MISSING_SECRET" };

export type UnexpectedFailure = { success: false; userError: OtherError };

/**
 * The success arm of a "start" result, without the `browserSecret`. The client
 * stores the secret itself; the caller has no use for it, and keeping it out
 * of the result keeps it out of URLs and logs.
 */
export type WithoutSecret<Result> = Result extends { success: true }
  ? Omit<Result, "browserSecret">
  : Result;

/**
 * The state of a landing page: `loading` until the link has been presented,
 * then `complete` or `error`.
 */
export type LinkFlowState<UserError> =
  | { status: "loading" }
  | { status: "complete" }
  | { status: "error"; userError: UserError };

/** The client of the landing page of a link that completes on its own. */
export type LinkFlowClient<State> = {
  /** The state of the flow. */
  state: ReadableStore<State>;
  /**
   * Present the link once, as soon as the `AuthClient` has loaded: read the
   * secret of the flow, run the completion, and clear the secret when the
   * flow is done. Call it when the page mounts. Further calls do nothing.
   * Returns the cleanup for the unmount, which only cancels a start that
   * still waits for the `AuthClient`.
   */
  start: () => () => void;
};

/** Fold a thrown error into a `success: false` result. */
export const foldError = (cause: unknown): UnexpectedFailure => ({
  success: false,
  userError: { error: "OTHER_ERROR", cause },
});

/**
 * The `start` of a landing page: run `run` once per client, on the first
 * start that sees a loaded `AuthClient`. We want this to run on page load.
 * This is acceptable: since we use browser secrets, we don't need an
 * additional user confirmation. The cleanup that `start` returns only
 * cancels a start that still waits for the `AuthClient`.
 */
export function startOnceLoaded(
  options: { authClient: Pick<AuthClient, "getSnapshot" | "subscribe"> },
  run: () => Promise<void>,
): () => () => void {
  let started = false;
  const runIfLoaded = () => {
    if (started || options.authClient.getSnapshot().isLoading) {
      return;
    }
    started = true;
    void run();
  };
  return () => {
    runIfLoaded();
    if (started) {
      return () => {};
    }
    const unsubscribe = options.authClient.subscribe(() => {
      runIfLoaded();
      if (started) {
        unsubscribe();
      }
    });
    return unsubscribe;
  };
}

/** See {@link LinkFlowClient}. */
export function createLinkFlow<UserError>(
  options: {
    authClient: Pick<AuthClient, "methodStorage" | "getSnapshot" | "subscribe">;
  },
  secretKey: string,
  complete: (
    browserSecret: string,
  ) => Promise<{ done: true } | { done: false; userError: UserError }>,
): LinkFlowClient<LinkFlowState<UserError | MissingSecretError | OtherError>> {
  const state = createStore<
    LinkFlowState<UserError | MissingSecretError | OtherError>
  >({ status: "loading" });
  const run = async () => {
    const storage = options.authClient.methodStorage;
    try {
      const browserSecret = await storage.get(secretKey);
      if (browserSecret === null || browserSecret === undefined) {
        state.set({ status: "error", userError: { error: "MISSING_SECRET" } });
        return;
      }
      const result = await complete(browserSecret);
      if (result.done) {
        await storage.remove(secretKey);
        state.set({ status: "complete" });
      } else {
        state.set({ status: "error", userError: result.userError });
      }
    } catch (cause) {
      state.set({
        status: "error",
        userError: { error: "OTHER_ERROR", cause },
      });
    }
  };

  return {
    state: { get: state.get, subscribe: state.subscribe },
    start: startOnceLoaded(options, run),
  };
}

/**
 * Run a "start" mutation of a link flow, keep the secret it returns, and
 * strip the secret from the result.
 */
export function createStartFlow<
  Args extends DefaultFunctionArgs,
  Result extends
    | { success: true; browserSecret: string }
    | { success: false; userError: unknown },
>(
  options: {
    authClient: Pick<AuthClient, "methodStorage">;
    convex: ConvexMutationApi;
  },
  mutation: () => FunctionReference<"mutation", "public", Args, Result>,
  secretKey: string,
) {
  const { pending, track } = createPendingTracker();
  const run = (
    args: Args,
  ): Promise<WithoutSecret<Result> | UnexpectedFailure> =>
    track(async () => {
      try {
        const result = await options.convex.mutation(mutation(), args as never);
        if (result.success) {
          await options.authClient.methodStorage.set(
            secretKey,
            result.browserSecret,
          );
          const { browserSecret: _, ...rest } = result;
          return rest as WithoutSecret<Result>;
        }
        return result as WithoutSecret<Result>;
      } catch (cause) {
        return foldError(cause);
      }
    });
  return { run, pending };
}
