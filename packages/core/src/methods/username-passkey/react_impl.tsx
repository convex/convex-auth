/**
 * Internal building blocks of the passkey React hooks (see `./react.tsx`):
 * the autofill request loop, and the modal ceremony slot of a page. They
 * are not part of the public API (at least for now — we might export
 * them later to make it easier to implement custom flows).
 *
 * @module
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  authenticateWithAutofill,
  foldClientError,
  type PasskeyClientFailure,
  supportsWebAuthn,
  type PasskeyClientError,
  type WireRequestOptions,
} from "./client.ts";
import { CHALLENGE_TTL_MS } from "../../components/passkey/constants.ts";
import type { WireAuthenticationResponse } from "../../components/passkey/validation.ts";

//------------------------------------------------------------------------------
// Autofill
//------------------------------------------------------------------------------

/**
 * The states of {@link usePasskeyAutofill}:
 *
 * - `"idle"`: the flow has not started yet, or autofill is off.
 * - `"waiting"`: the autofill request is pending in the browser.
 * - `"signingIn"`: a picked assertion is being handled (`onAssertion` is
 *   running, usually a server verification).
 * - `"signedIn"`: `onAssertion` reported success and the flow is done.
 * - `"stopped"`: the flow is done without a success (failure, or no
 *   browser support).
 */
export type PasskeyAutofillStatus =
  "idle" | "waiting" | "signingIn" | "signedIn" | "stopped";

/**
 * The gates of an autofill flow, which {@link usePasskeyAutofill} returns
 * among its fields.
 * `pauseAutofillFlow()` aborts the in-flight browser request and keeps the
 * loop parked; `resumeAutofillFlow()` lets the loop start a fresh request.
 * The pauses are reference-counted, so two modal flows on one page compose,
 * and they act on the hook, so they survive a restart of the autofill
 * effect. Both callbacks keep their identity for the life of the hook.
 *
 * The browser runs one WebAuthn ceremony at a time per page, thus **every**
 * modal ceremony on a page that runs autofill must pause the autofill flow
 * around itself. A ceremony that skips the pause takes the slot from the
 * pending autofill request, which the flow can only answer by stopping.
 *
 * `isAutofillSigningIn()` tells whether the server verifies a passkey that
 * the user picked from the autocompletion list (status `"signingIn"`). A
 * pause cannot stop this step, because the browser ceremony is already over,
 * thus a modal flow must not start during it.
 */
export type PasskeyAutofillGates = {
  pauseAutofillFlow: () => void;
  resumeAutofillFlow: () => void;
  isAutofillSigningIn: () => boolean;
};

// A pending autofill request refreshes its challenge before the server's
// challenge TTL expires. The two-minute margin makes sure the challenge
// that the user finally redeems is never expired.
const AUTOFILL_REFRESH_MS = CHALLENGE_TTL_MS - 2 * 60 * 1000;

// How often a pending autofill request compares the age of its challenge
// against `AUTOFILL_REFRESH_MS`. The age is wall-clock time, which a single
// long timer does not track: browsers throttle timers in background tabs,
// and page timers do not advance while the computer sleeps, whereas the
// server's TTL keeps running. The check is a clock read, so checking after
// a short period is cheap.
const AUTOFILL_STALENESS_CHECK_MS = 10 * 1000;

// The page events after which a pending autofill request re-checks the age
// of its challenge right away, rather than on the next periodic check: the
// user coming back to the page, and the user focusing a field (such as the
// username field whose autocompletion list offers the passkeys).
const STALENESS_CHECK_WINDOW_EVENTS = ["focus", "pageshow"] as const;
const STALENESS_CHECK_DOCUMENT_EVENTS = [
  "visibilitychange",
  "focusin",
] as const;

// After this many autofill assertions in a row come back as a failure,
// the autofill flow stops instead of asking the browser again.
const MAX_AUTOFILL_FAILURES = 3;

// What this hook tells a developer whose own ceremony took the browser's
// single ceremony slot without pausing the flow first.
const FOREIGN_CEREMONY_WARNING =
  "[convex-auth] The passkey autofill request was ended by another WebAuthn " +
  "ceremony, so autofill has stopped. A page that runs passkey autofill must " +
  "run every one of its modal ceremonies through the passkey hooks, so that " +
  "autofill yields the browser's single ceremony slot instead of competing " +
  "for it.";

/**
 * Handles passkey autofill (i.e. conditional mediation) on a page.
 *
 * This provides a user-friendly passkey UX where users see the list
 * of passkeys they have for the website when selecting the identifier
 * (e.g. username or email) field of the login form. When selecting
 * an account, it directly authenticates with it, without the user
 * having to go through more steps in the application.
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │  Log in                                      │
 * │                                              │
 * │  Username                                    │
 * │  ┌────────────────────────────────────────┐  │
 * │  │ ▏                                      │  │
 * │  └────────────────────────────────────────┘  │
 * │  ╭────────────────────────────────────────────────╮
 * │  │ 🔑  ada                                        │
 * │  │     Passkey · Apple Passwords                  │
 * │  │ 🔑  charles                                    │
 * └──│     Passkey · 1Password                        │
 *    ├────────────────────────────────────────────────┤
 *    │ 🔐  Use a different passkey…                   │
 *    ╰────────────────────────────────────────────────╯
 * ```
 *
 * This hook only handles the behavior. The login form is required to
 * render an `<input autoComplete="… webauthn">` input field.
 */
export function usePasskeyAutofill<E = never>(options: {
  /**
   * Set `false` to keep the autofill request off. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Mint fresh options (with a fresh challenge) for a
   * conditional-mediation request, usually through the start mutation of
   * the flow (the `startAutofillSignInWithUsernamePasskey` mutation of a passkey recipe).
   */
  start: () => Promise<WireRequestOptions>;
  /**
   * Handle the assertion of the passkey the user picked, usually by
   * sending it to the flow's finish mutation. Return `success: false` with
   * the flow's error to make the loop retry with a fresh challenge (up to
   * a small cap); return `success: true` to end the flow as `"signedIn"`.
   */
  onAssertion: (
    response: WireAuthenticationResponse,
  ) => Promise<{ success: true } | { success: false; userError: E }>;
}) {
  // The implementation flows from the following constraints:
  // - While usePasskeyAutofill is mounted, we (generally) have an ongoing
  //   conditional mediation request running.
  // - We start a new request once the challenge is ~8 minutes old (by the
  //   wall clock) because the challenge has a TTL of 10 minutes.
  // - The autofill system can be paused and then resumed. This is necessary
  //   because the browser doesn’t allow you to have concurrent WebAuthn
  //   challenges, so we need to pause autofill while a modal passkey
  //   challenge is running.

  const { enabled = true } = options;

  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<PasskeyAutofillStatus>("idle");
  const [lastError, setLastError] = useState<E | PasskeyClientError | null>(
    null,
  );

  // Reference-counted pauses, so that two modal flows on one page compose:
  // the first one to resume must not restart the loop while the second
  // still holds the ceremony slot. The count lives on the hook, so a pause
  // holds across an effect restart.
  const pauseCountRef = useRef(0);
  // Wakes the parked loop; `null` while the loop is not parked.
  const wakeRef = useRef<(() => void) | null>(null);
  // The `AbortController` of the conditional request that this hook has in
  // flight, or `null` when it has none. The hook owns it, rather than
  // letting `@simplewebauthn/browser` own the ceremony slot, because an
  // `AbortSignal` latches: an abort holds whether it arrives before, during,
  // or after the `get()` call, so `pause` needs no acknowledgement from the
  // loop and no ordering rule. It is also how the loop knows *who* ended a
  // request: this hook aborts this controller and nobody else does, so an
  // abort here is never another ceremony taking the browser's ceremony slot.
  const controllerRef = useRef<AbortController | null>(null);
  // `true` while `onAssertion` runs. A ref, not the `status` state, so that
  // a modal flow started in the same tick as the pick sees it.
  const signingInRef = useRef(false);

  // The loop reads the options through a ref: the callback identities
  // change on every render (they are usually inline closures), and the
  // pending browser request must not restart on a render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const pauseAutofillFlow = useCallback(() => {
    pauseCountRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  const resumeAutofillFlow = useCallback(() => {
    pauseCountRef.current = Math.max(0, pauseCountRef.current - 1);
    if (pauseCountRef.current === 0) {
      wakeRef.current?.();
    }
  }, []);

  const isAutofillSigningIn = useCallback(() => signingInRef.current, []);

  useEffect(() => {
    if (!enabled) {
      // Report the off state, so `status` does not stay stuck on the last
      // value of a previous enabled run.
      setStatus("idle");
      // No detection runs and the autocompletion list will not offer
      // passkeys. Report `false`, so `available` does not stay on `null`
      // ("detection runs") forever.
      setAvailable(false);
      return;
    }
    // The cleanup flips this, which makes the loop StrictMode-safe by
    // construction: the throwaway first mount's loop sees `alive: false`
    // after its first await and exits, while the second mount runs its own
    // loop.
    let alive = true;

    /** Park until `resume()` or the effect cleanup wakes us. */
    const park = () =>
      new Promise<void>((wake) => {
        wakeRef.current = () => {
          wakeRef.current = null;
          wake();
        };
      });

    const runLoop = async () => {
      // Feature-detect conditional mediation. The method is a static one,
      // and it is absent in older browsers: guard before calling it. Count
      // a rejection as "not available": if it escaped, the promise chain
      // below would reject unhandled and the hook would stay on
      // `available: null` and `status: "idle"` forever.
      let supported = false;
      try {
        supported =
          supportsWebAuthn() &&
          typeof PublicKeyCredential.isConditionalMediationAvailable ===
            "function" &&
          (await PublicKeyCredential.isConditionalMediationAvailable());
      } catch {
        // Keep `supported` as `false`.
      }
      if (!alive) {
        return;
      }
      setAvailable(supported);
      if (!supported) {
        setStatus("stopped");
        return;
      }

      let failures = 0;
      while (alive) {
        if (pauseCountRef.current > 0) {
          await park();
          continue;
        }

        setStatus("waiting");
        // Taken before the start mutation runs, so the age this loop
        // measures is never shorter than the age the server measures.
        const requestedAt = Date.now();
        let requestOptions;
        try {
          requestOptions = await optionsRef.current.start();
        } catch (cause) {
          if (!alive) {
            return;
          }
          setLastError(foldClientError(cause));
          setStatus("stopped");
          return;
        }
        if (!alive) {
          return;
        }
        if (pauseCountRef.current > 0) {
          // A pause came in while the challenge was being minted: park (at
          // the top of the loop) before a new browser request starts.
          continue;
        }

        // Published before the request starts, and nothing yields between
        // the gate check above and this line, so no pause can land in
        // between. From here on the abort itself covers every interleaving:
        // an `AbortSignal` latches, thus a pause that arrives while the
        // request is still starting up aborts it just as well as one that
        // arrives while it is pending, and `get()` refuses an
        // already-aborted signal on entry.
        const controller = new AbortController();
        controllerRef.current = controller;

        // Refresh before the server's challenge TTL, so the challenge
        // that the user finally redeems is never expired. A refresh that
        // fires while the user is resolving the ceremony does not discard
        // the result: the challenge the user redeemed is still inside its
        // TTL, and `get()` resolves with the assertion rather than with the
        // abort.
        //
        // The age is read from the wall clock, periodically and whenever
        // the user comes back to the page, instead of from one timer set
        // to `AUTOFILL_REFRESH_MS`: such a timer fires late in a throttled
        // background tab, and it does not count the time the computer
        // sleeps, which would leave an expired challenge pending on a page
        // that sat idle.
        const refreshIfStale = () => {
          if (Date.now() - requestedAt >= AUTOFILL_REFRESH_MS) {
            controller.abort();
          }
        };
        const refreshTimer = setInterval(
          refreshIfStale,
          AUTOFILL_STALENESS_CHECK_MS,
        );
        for (const event of STALENESS_CHECK_WINDOW_EVENTS) {
          window.addEventListener(event, refreshIfStale);
        }
        for (const event of STALENESS_CHECK_DOCUMENT_EVENTS) {
          document.addEventListener(event, refreshIfStale);
        }

        const result = await authenticateWithAutofill(
          requestOptions,
          controller.signal,
        );
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        clearInterval(refreshTimer);
        for (const event of STALENESS_CHECK_WINDOW_EVENTS) {
          window.removeEventListener(event, refreshIfStale);
        }
        for (const event of STALENESS_CHECK_DOCUMENT_EVENTS) {
          document.removeEventListener(event, refreshIfStale);
        }
        if (!alive) {
          return;
        }

        if (!result.success) {
          if (controller.signal.aborted) {
            // This hook ended its own request: a refresh, or a pause. The
            // two need no telling apart, because the top of the loop parks
            // if a pause is still owed and otherwise starts a request with
            // a fresh challenge, which is what both want.
            continue;
          }
          // Nothing this hook did ended the request, so another WebAuthn
          // ceremony took the browser's single ceremony slot, or the
          // browser refuses conditional requests outright. The two are
          // indistinguishable, and starting a fresh request would abort
          // whatever holds the slot (or spin against a browser that
          // refuses), so the flow stops and says so.
          if (result.userError.error === "CEREMONY_ABORTED") {
            console.warn(FOREIGN_CEREMONY_WARNING);
          }
          setLastError(result.userError);
          setStatus("stopped");
          return;
        }

        setStatus("signingIn");
        signingInRef.current = true;
        let outcome;
        try {
          outcome = await optionsRef.current.onAssertion(result.response);
        } catch (cause) {
          if (!alive) {
            return;
          }
          setLastError(foldClientError(cause));
          setStatus("stopped");
          return;
        } finally {
          signingInRef.current = false;
        }
        if (!alive) {
          return;
        }
        if (outcome.success) {
          // A failed attempt earlier in this loop can have set
          // `lastError`. The flow succeeded, so clear it.
          setLastError(null);
          setStatus("signedIn");
          return;
        }
        setLastError(outcome.userError);
        failures += 1;
        if (failures >= MAX_AUTOFILL_FAILURES) {
          setStatus("stopped");
          return;
        }
        // Try again with a fresh challenge.
      }
    };

    void runLoop();

    return () => {
      alive = false;
      controllerRef.current?.abort();
      // Never leave the loop parked; it exits on `alive`.
      wakeRef.current?.();
    };
  }, [enabled]);

  return useMemo(
    () => ({
      /**
       * Whether the browser can offer passkeys in the autocompletion list.
       * `null` while detection runs; `false` when autofill is off.
       */
      available,
      /** The state of the request; see {@link PasskeyAutofillStatus}. */
      status,
      /** The most recent failure, for display or logging. */
      lastError,
      /** Pause the flow; see {@link PasskeyAutofillGates}. */
      pauseAutofillFlow,
      /** Resume the flow; see {@link PasskeyAutofillGates}. */
      resumeAutofillFlow,
      /** See {@link PasskeyAutofillGates}. */
      isAutofillSigningIn,
    }),
    [
      available,
      status,
      lastError,
      pauseAutofillFlow,
      resumeAutofillFlow,
      isAutofillSigningIn,
    ],
  );
}

//------------------------------------------------------------------------------
// Modal ceremony slot
//------------------------------------------------------------------------------

/**
 * A call on a flow whose previous call still runs. The first flow keeps
 * its browser dialog and resolves as usual, thus a caller that gets this
 * shows nothing.
 */
export type AlreadyPendingError = { error: "ALREADY_PENDING" };

/**
 * Failure shape for {@link AlreadyPendingError}.
 */
export type AlreadyPendingFailure = {
  success: false;
  userError: AlreadyPendingError;
};

/**
 * Building block for modal passkey flows: a `run` callback that runs one
 * modal ceremony at a time, plus its `pending` state.
 *
 * `run(fn)` guards the invariants every modal flow needs:
 *
 * - It refuses a second call while one is running and returns an
 *   {@link AlreadyPendingFailure} instead. A second modal ceremony would be
 *   rejected by the browser, and a nested call would deadlock the autofill
 *   pause/resume protocol.
 * - It also refuses a call while the server verifies an autofill sign-in.
 *   That sign-in cannot be paused, and both flows would set a session.
 * - It pauses the autofill flow of the page, when there is one, before
 *   `fn` and resumes it when `fn` is done, whatever the outcome. The
 *   ceremony of `fn` displaces the pending conditional request anyway (the browser runs one ceremony at a
 *   time per page); the pause keeps the autofill loop from starting a new
 *   request mid-ceremony, and the resume restarts it.
 * - It folds every value `fn` throws into the envelope's error arm, so
 *   callers handle every failure through one `userError` switch.
 *
 * `pause()` returns at once and needs no acknowledgement, because the
 * autofill hook aborts its request through an `AbortSignal` it owns, and an
 * `AbortSignal` latches. A pause that lands while a conditional request is
 * still starting up aborts it just as well as one that lands while it is
 * pending: `get()` refuses an already-aborted signal on entry. The pause
 * thus holds for every interleaving, and `fn` never has its ceremony taken
 * by the autofill loop.
 */
export function usePasskeyCeremonySlot(options: {
  /**
   * The gates of the autofill flow of the page, or `null` when the page
   * runs none, which is the case of a settings page.
   */
  autofill: PasskeyAutofillGates | null;
}) {
  // Depend on destructured values, not on `options.autofill`, which changes
  // identity on each state change.
  const { pauseAutofillFlow, resumeAutofillFlow, isAutofillSigningIn } =
    options.autofill ?? {};

  const [pending, setPending] = useState(false);
  // The re-entry guard reads through a ref: `pending` from `useState`
  // would be stale inside the callback.
  const pendingRef = useRef(false);

  const run = useCallback(
    // The trailing comma keeps the generic from parsing as JSX in a .tsx
    // file.
    async <T,>(
      fn: () => Promise<T>,
    ): Promise<T | PasskeyClientFailure | AlreadyPendingFailure> => {
      if (pendingRef.current || isAutofillSigningIn?.()) {
        // TODO(nicolas): Consider a different behavior here. The caller has
        // nothing to show for this error, since the first ceremony keeps its
        // dialog and resolves as usual.
        return { success: false, userError: { error: "ALREADY_PENDING" } };
      }
      pendingRef.current = true;
      setPending(true);
      // The closure holds one pair of gates, so pause and resume act on
      // the same autofill flow even when a render hands over a different
      // flow mid-ceremony. The pauses are counted by the autofill hook
      // itself, so the pair stays balanced even when its effect restarts
      // mid-ceremony.
      pauseAutofillFlow?.();
      try {
        return await fn();
      } catch (cause) {
        return { success: false, userError: foldClientError(cause) };
      } finally {
        resumeAutofillFlow?.();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [pauseAutofillFlow, resumeAutofillFlow, isAutofillSigningIn],
  );

  return {
    /** Run `fn` as the one modal ceremony of the page. */
    run,
    /** `true` while a `run` call is running. */
    pending,
  };
}
