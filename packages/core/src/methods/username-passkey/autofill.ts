/**
 * The framework-agnostic building blocks of the passkey clients: the
 * autofill request loop of a sign-in page ({@link createPasskeyAutofill}),
 * and the slot that runs one modal ceremony at a time
 * ({@link createPasskeyCeremonySlot}). The page clients of `signInClient.ts`
 * and `management/managementClient.ts` are made of them. They are internal:
 * a binding uses the page clients.
 *
 * This module holds no platform code: the ceremonies come in as a
 * {@link ResolvedPasskeyCeremonies}. It thus never imports `client.ts` or
 * `@simplewebauthn/browser`, which keeps it usable from `react-custom.tsx`.
 *
 * @module
 */

import { CHALLENGE_TTL_MS } from "../../components/passkey/constants.ts";
import type {
  WireAuthenticationResponse,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
import { createStore, type ReadableStore } from "../../browser/store.ts";
import {
  foldClientError,
  type PasskeyClientError,
  type PasskeyClientFailure,
  type ResolvedPasskeyCeremonies,
} from "./ceremonies.ts";

//------------------------------------------------------------------------------
// Autofill
//------------------------------------------------------------------------------

/**
 * The states of the autofill flow:
 *
 * - `"idle"`: the flow has not started yet, or `stop()`
 *   ended it (a microtask after the call, unless the flow started again in
 *   the meantime). A pick that still verified at the stop reports its end
 *   once no loop runs any more: `"idle"` with its `lastError` when it fails,
 *   or `"signedIn"`. While a newer loop runs, the state moves on to
 *   `"waiting"` instead.
 * - `"waiting"`: the autofill request is pending in the browser.
 * - `"signingIn"`: a picked assertion is being handled (`onAssertion` is
 *   running, usually a server verification).
 * - `"signedIn"`: `onAssertion` reported success and the flow is done.
 * - `"stopped"`: the flow is done without a success (failure, or no
 *   browser support).
 */
export type PasskeyAutofillStatus =
  "idle" | "waiting" | "signingIn" | "signedIn" | "stopped";

/** The state of an autofill flow. */
export type PasskeyAutofillState<E> = {
  /**
   * Whether the platform can offer passkeys in the autocompletion list.
   * `null` while detection runs; `false` when the platform has no autofill.
   * A stop keeps the last value.
   */
  available: boolean | null;
  /** The state of the request; see {@link PasskeyAutofillStatus}. */
  status: PasskeyAutofillStatus;
  /** The most recent failure, for display or logging. */
  lastError: E | PasskeyClientError | null;
};

/**
 * The gates of an autofill flow, which {@link createPasskeyAutofill} returns
 * among its fields.
 * `pauseAutofillFlow()` aborts the in-flight browser request and keeps the
 * loop parked; `resumeAutofillFlow()` lets the loop start a fresh request.
 * The pauses are reference-counted, so two modal flows on one page compose,
 * and they act on the flow, so they survive a restart of the loop.
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

/** What {@link createPasskeyAutofill} takes. */
export type PasskeyAutofillOptions<E> = {
  /**
   * The passkey ceremonies of the platform. The loop reads them once per
   * {@link PasskeyAutofill.start}.
   */
  ceremonies: ResolvedPasskeyCeremonies;
  /**
   * Mint fresh options (with a fresh challenge) for a conditional-mediation
   * request, usually through the start mutation of the flow (the
   * `startAutofillSignInWithUsernamePasskey` mutation of a passkey recipe).
   */
  start: () => Promise<WireRequestOptions>;
  /**
   * Handle the assertion of the passkey the user picked, usually by sending
   * it to the flow's finish mutation. Return `success: false` with the
   * flow's error to make the loop retry with a fresh challenge (up to a
   * small cap); return `success: true` to end the flow as `"signedIn"`.
   */
  onAssertion: (
    response: WireAuthenticationResponse,
  ) => Promise<{ success: true } | { success: false; userError: E }>;
};

/** An autofill flow; see {@link createPasskeyAutofill}. */
export type PasskeyAutofill<E> = PasskeyAutofillGates & {
  /** The state of the flow. */
  state: ReadableStore<PasskeyAutofillState<E>>;
  /**
   * Start the request loop. Call it when the sign-in page mounts. Returns
   * the function that stops the loop and aborts its request, for the
   * unmount. The flow can be started again after a stop: the pauses carry
   * over.
   */
  start: () => () => void;
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

// After this many autofill assertions in a row come back as a failure,
// the autofill flow stops instead of asking the browser again.
const MAX_AUTOFILL_FAILURES = 3;

// What this flow tells a developer whose own ceremony took the browser's
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
 * This only handles the behavior. The login form is required to render an
 * `<input autoComplete="… webauthn">` input field. The flow reads its
 * options when it uses them, so a binding can pass getters.
 */
export function createPasskeyAutofill<E = never>(
  options: PasskeyAutofillOptions<E>,
): PasskeyAutofill<E> {
  // The implementation flows from the following constraints:
  // - While the flow is started, we (generally) have an ongoing conditional
  //   mediation request running.
  // - We start a new request once the challenge is ~8 minutes old (by the
  //   wall clock) because the challenge has a TTL of 10 minutes.
  // - The autofill system can be paused and then resumed. This is necessary
  //   because the browser doesn’t allow you to have concurrent WebAuthn
  //   challenges, so we need to pause autofill while a modal passkey
  //   challenge is running.

  const state = createStore<PasskeyAutofillState<E>>({
    available: null,
    status: "idle",
    lastError: null,
  });
  const update = (patch: Partial<PasskeyAutofillState<E>>) => {
    const current = state.get();
    if (
      Object.entries(patch).every(
        ([key, value]) =>
          current[key as keyof PasskeyAutofillState<E>] === value,
      )
    ) {
      return;
    }
    state.set({ ...current, ...patch });
  };

  // Reference-counted pauses, so that two modal flows on one page compose:
  // the first one to resume must not restart the loop while the second
  // still holds the ceremony slot. The count lives on the flow, so a pause
  // holds across a restart of the loop.
  let pauseCount = 0;
  // Wakes the parked loop; `null` while the loop is not parked.
  let wake: (() => void) | null = null;
  // The `AbortController` of the conditional request that this flow has in
  // flight, or `null` when it has none. The flow owns it, rather than
  // letting `@simplewebauthn/browser` own the ceremony slot, because an
  // `AbortSignal` latches: an abort holds whether it arrives before, during,
  // or after the `get()` call, so `pause` needs no acknowledgement from the
  // loop and no ordering rule. It is also how the loop knows *who* ended a
  // request: this flow aborts this controller and nobody else does, so an
  // abort here is never another ceremony taking the browser's ceremony slot.
  let activeController: AbortController | null = null;
  // How many `onAssertion` calls run. A variable, not the `status` of the
  // state, so that a modal flow started in the same tick as the pick sees
  // it. A count, because a loop that was stopped mid-verification keeps
  // verifying, and its end must not unlock the verification of a newer loop.
  let verifying = 0;
  // The verification that runs, if any. A new loop waits for it before it
  // asks the browser for another assertion, so two picks never verify at
  // once.
  let verification: Promise<void> | null = null;

  const pauseAutofillFlow = () => {
    pauseCount += 1;
    activeController?.abort();
  };

  const resumeAutofillFlow = () => {
    pauseCount = Math.max(0, pauseCount - 1);
    if (pauseCount === 0) {
      wake?.();
    }
  };

  const isAutofillSigningIn = () => verifying > 0;

  // The stop of the running loop. A second `start` stops the first loop, so
  // two loops never compete for the browser's single conditional request.
  let stopRunning: (() => void) | null = null;

  const start = () => {
    stopRunning?.();
    const ceremonies = options.ceremonies;
    // The stop flips this, which makes the loop safe to start again (as
    // React's StrictMode does) by construction: the stopped loop sees
    // `alive: false` after its next await and exits, while the new start
    // runs its own loop.
    let alive = true;

    /** Park until `resume()` or the stop wakes us. */
    const park = () =>
      new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });

    const runLoop = async () => {
      // Feature-detect autofill through the ceremonies of the platform. Count
      // a rejection as "not available": if it escaped, the promise chain
      // below would reject unhandled and the flow would stay on
      // `available: null` and `status: "idle"` forever.
      let supported = false;
      try {
        supported = await ceremonies.isAutofillAvailable();
      } catch {
        // Keep `supported` as `false`.
      }
      if (!alive) {
        return;
      }
      update({ available: supported });
      if (!supported) {
        update({ status: "stopped" });
        return;
      }

      let failures = 0;
      while (alive) {
        if (pauseCount > 0) {
          await park();
          continue;
        }
        if (verification !== null) {
          // A stopped loop still verifies its pick. Wait for its end.
          await verification;
          continue;
        }

        update({ status: "waiting" });
        // Taken before the start mutation runs, so the age this loop
        // measures is never shorter than the age the server measures.
        const requestedAt = Date.now();
        let requestOptions;
        try {
          requestOptions = await options.start();
        } catch (cause) {
          if (!alive) {
            return;
          }
          update({ lastError: foldClientError(cause), status: "stopped" });
          return;
        }
        if (!alive) {
          return;
        }
        if (pauseCount > 0) {
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
        activeController = controller;

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
        const stopResumeChecks = ceremonies.onResume(refreshIfStale);

        const result = await ceremonies.authenticateWithAutofill(
          requestOptions,
          controller.signal,
        );
        if (activeController === controller) {
          activeController = null;
        }
        clearInterval(refreshTimer);
        stopResumeChecks();
        if (!alive) {
          return;
        }

        if (!result.success) {
          if (controller.signal.aborted) {
            // This flow ended its own request: a refresh, or a pause. The
            // two need no telling apart, because the top of the loop parks
            // if a pause is still owed and otherwise starts a request with
            // a fresh challenge, which is what both want.
            continue;
          }
          // Nothing this flow did ended the request, so another WebAuthn
          // ceremony took the browser's single ceremony slot, or the
          // browser refuses conditional requests outright. The two are
          // indistinguishable, and starting a fresh request would abort
          // whatever holds the slot (or spin against a browser that
          // refuses), so the flow stops and says so.
          if (result.userError.error === "CEREMONY_ABORTED") {
            console.warn(FOREIGN_CEREMONY_WARNING);
          }
          update({ lastError: result.userError, status: "stopped" });
          return;
        }

        // Lock out the modal flow before telling subscribers: a listener
        // runs synchronously and may call `signIn` right away.
        verifying += 1;
        update({ status: "signingIn" });
        const run = (async (): Promise<
          | { outcome: Awaited<ReturnType<typeof options.onAssertion>> }
          | { thrown: unknown }
        > => {
          try {
            return { outcome: await options.onAssertion(result.response) };
          } catch (cause) {
            return { thrown: cause };
          } finally {
            // Unlock before anything below tells subscribers.
            verifying -= 1;
          }
        })();
        const settled = run.then(() => {});
        verification = settled;
        const ended = await run;
        if (verification === settled) {
          verification = null;
        }
        const error =
          "thrown" in ended
            ? foldClientError(ended.thrown)
            : ended.outcome.success
              ? null
              : ended.outcome.userError;
        if (!alive) {
          // Stopped mid-verification. Settle the state of this pick, so it
          // doesn't stay on "signingIn" for good: by its end when no loop
          // runs, or as "waiting" for the newer loop, which may sit parked on
          // a pause and publish nothing until the resume.
          if (stopRunning === null) {
            // No loop runs, so this pick is the latest news: report its end,
            // whatever a newer loop that ran in between published.
            update(
              error === null
                ? { lastError: null, status: "signedIn" }
                : { lastError: error, status: "idle" },
            );
          } else if (state.get().status === "signingIn") {
            update({ status: "waiting" });
          }
          return;
        }
        if ("thrown" in ended) {
          update({ lastError: error, status: "stopped" });
          return;
        }
        const outcome = ended.outcome;
        if (outcome.success) {
          // A failed attempt earlier in this loop can have set
          // `lastError`. The flow succeeded, so clear it.
          update({ lastError: null, status: "signedIn" });
          return;
        }
        update({ lastError: outcome.userError });
        failures += 1;
        if (failures >= MAX_AUTOFILL_FAILURES) {
          update({ status: "stopped" });
          return;
        }
        // Try again with a fresh challenge.
      }
    };

    void runLoop();

    const stop = () => {
      // A second call, or the stop of a loop that a later `start` already
      // stopped, must not abort the request of the loop that runs now.
      if (!alive) return;
      alive = false;
      stopRunning = null;
      // A request that waits ends with the stop. A pick that verifies keeps
      // "signingIn" until its loop settles it. Checked a microtask later, so
      // a restart in the same tick (an effect's cleanup, then its next run)
      // keeps "waiting" instead of flickering through "idle".
      if (state.get().status === "waiting") {
        queueMicrotask(() => {
          if (stopRunning === null && state.get().status === "waiting") {
            update({ status: "idle" });
          }
        });
      }
      activeController?.abort();
      // Never leave the loop parked; it exits on `alive`.
      wake?.();
    };
    stopRunning = stop;
    return stop;
  };

  return {
    state: { get: state.get, subscribe: state.subscribe },
    start,
    pauseAutofillFlow,
    resumeAutofillFlow,
    isAutofillSigningIn,
  };
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

/** A slot for modal ceremonies; see {@link createPasskeyCeremonySlot}. */
export type PasskeyCeremonySlot = {
  /** Run `fn` as the one modal ceremony of the page. */
  run: <T>(
    fn: () => Promise<T>,
  ) => Promise<T | PasskeyClientFailure | AlreadyPendingFailure>;
  /** `true` while a `run` call is running. */
  pending: ReadableStore<boolean>;
};

/**
 * Building block for modal passkey flows: a `run` function that runs one
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
 *   ceremony of `fn` displaces the pending conditional request anyway (the
 *   browser runs one ceremony at a time per page); the pause keeps the
 *   autofill loop from starting a new request mid-ceremony, and the resume
 *   restarts it.
 * - It folds every value `fn` throws into the envelope's error arm, so
 *   callers handle every failure through one `userError` switch.
 *
 * `pause()` returns at once and needs no acknowledgement, because the
 * autofill flow aborts its request through an `AbortSignal` it owns, and an
 * `AbortSignal` latches. A pause that lands while a conditional request is
 * still starting up aborts it just as well as one that lands while it is
 * pending: `get()` refuses an already-aborted signal on entry. The pause
 * thus holds for every interleaving, and `fn` never has its ceremony taken
 * by the autofill loop.
 */
export function createPasskeyCeremonySlot(options: {
  /**
   * The gates of the autofill flow of the page, or `null` when the page
   * runs none, which is the case of a settings page. Read at each `run`.
   */
  autofill: PasskeyAutofillGates | null;
}): PasskeyCeremonySlot {
  const pending = createStore(false);

  const run = async <T>(
    fn: () => Promise<T>,
  ): Promise<T | PasskeyClientFailure | AlreadyPendingFailure> => {
    // One pair of gates per call, so pause and resume act on the same
    // autofill flow even when the options hand over a different flow
    // mid-ceremony. The pauses are counted by the autofill flow itself, so
    // the pair stays balanced even when its loop restarts mid-ceremony.
    const gates = options.autofill;
    if (pending.get() || gates?.isAutofillSigningIn()) {
      // TODO(nicolas): Consider a different behavior here. The caller has
      // nothing to show for this error, since the first ceremony keeps its
      // dialog and resolves as usual.
      return { success: false, userError: { error: "ALREADY_PENDING" } };
    }
    pending.set(true);
    gates?.pauseAutofillFlow();
    try {
      return await fn();
    } catch (cause) {
      return { success: false, userError: foldClientError(cause) };
    } finally {
      gates?.resumeAutofillFlow();
      pending.set(false);
    }
  };

  return { run, pending: { get: pending.get, subscribe: pending.subscribe } };
}
