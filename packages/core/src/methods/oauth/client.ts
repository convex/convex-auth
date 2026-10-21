/**
 * Framework-agnostic client for the OAuth providers.
 *
 * Sign-in spans a full page round-trip, so this client saves what it needs
 * before navigating away and finishes the flow at startup. The server hands
 * back a `state` when a flow starts and this client keeps it locally, then
 * sends it back with the code from the callback URL. That pairing is what
 * proves this browser started the sign-in.
 *
 * Starting a flow returns a redirect URL rather than a session, so it runs on
 * the plain Convex client. Only the redemption, which returns the shared
 * sign-in envelope, runs on the sign-in api, which is the auth proxy under SSR.
 *
 * @module
 */
import {
  FunctionReference,
  getFunctionName,
  makeFunctionReference,
} from "convex/server";
import { ConvexError } from "convex/values";
import type { AmbientSignInClient } from "../../browser/ambientSignInClient.ts";
import { retryOnNetworkError } from "../../browser/retry.ts";
import type { SignInStorage } from "../../browser/storage.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";
import type { ClientView } from "../../lib/types.ts";
import type { CompleteSignInResult } from "../../lib/oauth/redemption.ts";

/**
 * The mutations that the method of an OAuth provider adds to the app's API. Passed as
 * references, not names, because an app can re-export them under any name.
 */
export type OauthProviderApi = {
  /** The provider's `startSignIn*` mutation. */
  startSignIn: FunctionReference<
    "mutation",
    "public",
    { redirectTo: string },
    { redirect: string; state: string }
  >;
  /** The provider's `completeSignIn*` mutation. */
  completeSignIn: FunctionReference<
    "mutation",
    "public",
    { code: string; state: string },
    ClientView<CompleteSignInResult>
  >;
};

/** One provider's mutations plus its name. */
export type OauthProviderRefs = {
  /** The provider's name, e.g. `"google"`. Only a label, never a lookup key. */
  providerName: string;
} & OauthProviderApi;

/**
 * Why a flow failed after the identity provider sent the user back. The
 * callback lands on a page load with no caller waiting on it, so the hooks
 * report it as `flowError`. Apps switch on `error` and supply their own text
 * for each code.
 *
 * - `"ACCESS_DENIED"`: the user cancelled at the identity provider.
 * - `"EXPIRED"`: the flow took too long, or the code was already redeemed.
 * - `"INVALID_FLOW"`: the callback arrived but this client has no saved flow,
 *   so it never started this sign-in or already finished it.
 * - `"REJECTED"`: the app's own backend turned the sign-in down by throwing a
 *   `ConvexError`. `data` is that error's `data`.
 * - `"OTHER_ERROR"`: anything else, like the identity provider failing the
 *   handshake or the redemption throwing. `cause` is the thrown value, or the
 *   error the callback URL carried.
 */
export type OauthFlowError =
  | { error: "ACCESS_DENIED" }
  | { error: "EXPIRED" }
  | { error: "INVALID_FLOW" }
  | { error: "REJECTED"; data: unknown }
  | { error: "OTHER_ERROR"; cause: unknown };

/**
 * What starting a flow resolves to. A failure comes back as `OTHER_ERROR`
 * with the thrown value on `cause`, as with the password hooks, so the caller
 * handles every outcome in one switch with no `try`/`catch`. It only rejects
 * when `redirectTo` is missing where there is no page URL, which is a bug in
 * the calling code.
 *
 * On the web the client navigates to `redirect` itself. React Native has no
 * page to leave, so it opens `redirect` in an in-app browser.
 */
export type OauthStartResult =
  | { status: "redirect"; redirect: URL }
  | { status: "error"; userError: { error: "OTHER_ERROR"; cause: unknown } };

/**
 * What finishing a saved flow with a callback `code` resolves to. It never
 * rejects. The failures are those of {@link OauthFlowError}.
 */
export type OauthCompleteResult =
  { status: "complete" } | { status: "error"; userError: OauthFlowError };

/** Options accepted by {@link OauthActions.signIn}. */
export type SignInOptions = {
  /**
   * Where the flow returns to when it finishes. Defaults to the current URL,
   * and is required where there is no current URL, such as React Native.
   * Must be an http or https URL. Custom schemes like `myapp://` are not
   * supported yet.
   */
  redirectTo?: string;
  /** A callback `code` to finish a saved flow instead of starting a new one. */
  code?: string;
};

/** The sign-in actions {@link oauth} publishes for its hooks to read. */
export type OauthActions = {
  /**
   * Start the given provider's OAuth flow, or finish a saved one when
   * `options.code` is set. Starting navigates away to the identity provider.
   * Resolves to an {@link OauthStartResult} or, with a `code`, an
   * {@link OauthCompleteResult}.
   */
  signIn: (
    refs: OauthProviderRefs,
    options?: SignInOptions,
  ) => Promise<OauthStartResult | OauthCompleteResult>;
};

/** The id {@link oauth} registers under. */
export const OAUTH_SETUP_ID = "oauth";

/** Key {@link oauth} publishes its {@link OauthActions} under. */
export const OAUTH_ACTIONS_KEY = "actions";

/**
 * Key holding the current {@link OauthFlowError}, or `null` when the last
 * attempt was fine. It is set at registration, so `undefined` means
 * {@link oauth} was never registered.
 */
export const OAUTH_FLOW_ERROR_KEY = "flowError";

/**
 * The flow error for an `error` the server callback put in the URL. The
 * server sends `access_denied`, `expired`, or `oauth_error`. Anything else is
 * treated like `oauth_error`.
 */
function callbackFlowError(param: string): OauthFlowError {
  switch (param) {
    case "access_denied":
      return { error: "ACCESS_DENIED" };
    case "expired":
      return { error: "EXPIRED" };
    default:
      return { error: "OTHER_ERROR", cause: param };
  }
}

/**
 * The flow error for a redemption that threw. A `ConvexError` means the
 * app's backend rejected the sign-in. Anything else is unexpected.
 */
function thrownFlowError(error: unknown): OauthFlowError {
  if (error instanceof ConvexError) {
    return { error: "REJECTED", data: error.data };
  }
  return { error: "OTHER_ERROR", cause: error };
}

/** Storage key for the saved sign-in flow. */
const OAUTH_FLOW_STORAGE_KEY = "flow";

/** What `signIn` saves before it navigates to the identity provider. */
export type PendingFlow = {
  /** Which provider the flow belongs to. */
  providerName: string;
  /**
   * The state the server gave back at sign-in. Proof this client started the
   * flow.
   */
  state: string;
  /**
   * The path of the provider's `completeSignIn` mutation, from
   * `getFunctionName`. The flow can return to any page of the app, including
   * one that never held the mutation reference, so the path is saved here and
   * the reference is rebuilt from it. If the app renamed that export and
   * redeployed mid-flight the path no longer resolves and the sign-in fails
   * as `OTHER_ERROR`.
   */
  completeSignIn: string;
};

/**
 * The current page URL, or null where there is none. React Native defines
 * `window` but no `window.location`, so checking for `window` alone isn't
 * enough.
 */
function currentHref(): string | null {
  if (typeof window === "undefined" || window.location === undefined) {
    return null;
  }
  return window.location.href;
}

/**
 * Read and remove the saved sign-in flow. It is removed even if the redeem
 * that follows fails, because the code it pairs with is one-time and cannot
 * be used again anyway.
 */
async function takePendingFlow(
  storage: SignInStorage,
): Promise<PendingFlow | null> {
  const raw = await storage.get(OAUTH_FLOW_STORAGE_KEY);
  await storage.remove(OAUTH_FLOW_STORAGE_KEY);
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      providerName?: unknown;
      state?: unknown;
      completeSignIn?: unknown;
    };
    if (
      typeof parsed.providerName !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.completeSignIn !== "string"
    ) {
      return null;
    }
    return {
      providerName: parsed.providerName,
      state: parsed.state,
      completeSignIn: parsed.completeSignIn,
    };
  } catch {
    return null;
  }
}

/**
 * Remove the saved sign-in flow after it has ended. Callers don't await this,
 * so a failed removal is ignored instead of becoming an unhandled rejection.
 * The caller already recorded why the sign-in failed.
 */
async function dropPendingFlow(storage: SignInStorage): Promise<void> {
  try {
    await storage.remove(OAUTH_FLOW_STORAGE_KEY);
  } catch {
    // Nothing to do. The flow was already over.
  }
}

/**
 * Client setup for the OAuth providers. It owns the flow's storage and the
 * startup work that finishes a flow. Provider mutations arrive with each
 * {@link OauthActions.signIn} call, so the setup takes no configuration.
 */
export function oauth(): AmbientSignInClient {
  const setup: AmbientSignInClient["setup"] = ({
    client,
    values,
    storage,
    signInApi,
    convex,
    replaceUrl,
  }) => {
    /** Set or clear the flow error apps read for sign-in feedback. */
    const setFlowError = (flowError: OauthFlowError | null): void => {
      values.set(OAUTH_FLOW_ERROR_KEY, flowError);
    };

    /**
     * Redeem a callback `code` against the saved flow and adopt the session.
     * It never rejects. Every failure comes back in the result instead, so
     * callers that don't await it are safe. Callers run it inside
     * `withSignInPending`, together with whatever they do with the result, so
     * the auth state stays on loading until the client is signed in or the
     * failure is recorded, rather than flickering through signed out.
     */
    const redeem = async (code: string): Promise<OauthCompleteResult> => {
      // The storage read is inside the try so that a failed read is reported
      // like any other failure here.
      try {
        const pending = await takePendingFlow(storage);
        if (pending === null) {
          return { status: "error", userError: { error: "INVALID_FLOW" } };
        }
        // TODO(erquhart) Look at getting this reference without storing its
        // path.
        const completeSignIn = makeFunctionReference<"mutation">(
          pending.completeSignIn,
        ) as OauthProviderApi["completeSignIn"];
        const result = await retryOnNetworkError(() =>
          signInApi.mutation(completeSignIn, { code, state: pending.state }),
        );
        if (result.status === "error") {
          // The server can't tell unknown, already redeemed, expired, and
          // mismatched state apart, so they all land here.
          return { status: "error", userError: { error: "EXPIRED" } };
        }
        await client.setSession(result.tokens);
        return { status: "complete" };
      } catch (error) {
        return { status: "error", userError: thrownFlowError(error) };
      }
    };

    /**
     * Finish a flow the callback redirected back to. The params are read and
     * stripped from the URL before the first await, so if this runs twice the
     * second run sees a clean URL and does nothing. Only the params this
     * client owns are touched, so a `?code=` or `?error=` the app uses for its
     * own purposes is left alone.
     */
    const handleCallback = (): void => {
      const href = currentHref();
      if (href === null) {
        return;
      }
      const url = new URL(href);
      const code = url.searchParams.get(OAUTH_CODE_PARAM);
      const errorParam = url.searchParams.get(OAUTH_ERROR_PARAM);
      if (code === null && errorParam === null) {
        return;
      }
      url.searchParams.delete(OAUTH_CODE_PARAM);
      url.searchParams.delete(OAUTH_ERROR_PARAM);
      replaceUrl(url.toString());
      if (errorParam !== null) {
        // The server ended the flow with an error, so the saved state can
        // never be used. Drop it now so a stray code arriving later still
        // reports `INVALID_FLOW`.
        void dropPendingFlow(storage);
        setFlowError(callbackFlowError(errorParam));
        return;
      }
      if (code === null) {
        return;
      }
      // Nothing waits on this page load, so a failure is published for the
      // hooks to report as `flowError`. It is published before the pending
      // sign-in ends, so the auth state never reports signed out and done
      // loading without the error that explains it.
      void client.withSignInPending(async () => {
        const result = await redeem(code);
        if (result.status === "error") {
          setFlowError(result.userError);
        }
      });
    };

    /** Start a provider's flow, or finish a saved one when `code` is given. */
    const signIn: OauthActions["signIn"] = async (refs, options) => {
      const code = options?.code;
      if (code !== undefined) {
        setFlowError(null);
        return await client.withSignInPending(() => redeem(code));
      }
      const href = currentHref();
      const redirectTo = options?.redirectTo ?? href;
      if (redirectTo === null) {
        throw new Error(
          "`redirectTo` is required where there is no current page URL, " +
            "such as React Native.",
        );
      }
      // Cleared here rather than at the top, so a call that throws above
      // leaves any error the app is showing alone.
      setFlowError(null);
      try {
        const { redirect, state } = await convex.mutation(refs.startSignIn, {
          redirectTo,
        });
        await storage.set(
          OAUTH_FLOW_STORAGE_KEY,
          JSON.stringify({
            providerName: refs.providerName,
            state,
            completeSignIn: getFunctionName(refs.completeSignIn),
          } satisfies PendingFlow),
        );
        const url = new URL(redirect);
        // Don't navigate where there's no page URL to leave. React Native has
        // none, so it gets the url back, opens it in an in-app browser, and
        // finishes with `signIn(refs, { code })`.
        if (href !== null && navigator.product !== "ReactNative") {
          window.location.href = url.toString();
        }
        return { status: "redirect", redirect: url };
      } catch (cause) {
        // The caller is waiting on this, so the failure goes back to it, as
        // with the password hooks, rather than into the flow error.
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      }
    };

    values.set(OAUTH_ACTIONS_KEY, { signIn } satisfies OauthActions);
    setFlowError(null);
    return { onInit: handleCallback };
  };
  return { id: OAUTH_SETUP_ID, setup };
}
