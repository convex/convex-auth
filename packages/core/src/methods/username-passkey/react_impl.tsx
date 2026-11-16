/**
 * Internal building blocks of the passkey React hooks (see `./react.tsx`):
 * the autofill request loop, and the modal ceremony slot of a page. They
 * wrap the framework-agnostic {@link createPasskeyAutofill} and
 * {@link createPasskeyCeremonySlot} of `./autofill.ts`. They are not part of
 * the public API (at least for now — we might export them later to make it
 * easier to implement custom flows).
 *
 * @module
 */
"use client";

import { useEffect, useMemo } from "react";
import { useMethodClient, useReadableStore } from "../../react/store.ts";
import {
  createPasskeyAutofill,
  createPasskeyCeremonySlot,
  type PasskeyAutofillGates,
  type PasskeyAutofillOptions,
} from "./autofill.ts";

export type {
  AlreadyPendingError,
  AlreadyPendingFailure,
  PasskeyAutofillGates,
  PasskeyAutofillStatus,
} from "./autofill.ts";

/**
 * Handles passkey autofill (i.e. conditional mediation) on a page, while the
 * component is mounted. See {@link createPasskeyAutofill}.
 *
 * This hook only handles the behavior. The login form is required to
 * render an `<input autoComplete="… webauthn">` input field.
 */
export function usePasskeyAutofill<E = never>(
  options: PasskeyAutofillOptions<E> & {
    /**
     * Set `false` to keep the autofill request off. Defaults to `true`.
     */
    enabled?: boolean;
  },
) {
  const { enabled = true, ceremonies } = options;
  // One flow per hook instance, so the pauses hold across a restart of the
  // effect. It reads the options of the latest render: the callback
  // identities change on every render (they are usually inline closures),
  // and the pending browser request must not restart on a render.
  const autofill = useMethodClient(createPasskeyAutofill<E>, options);
  const { available, status, lastError } = useReadableStore(autofill.state);

  useEffect(() => {
    if (!enabled) {
      autofill.disable();
      return;
    }
    // In StrictMode the throwaway first mount's loop is stopped, and the
    // second mount runs its own loop.
    return autofill.start();
  }, [enabled, ceremonies, autofill]);

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
      pauseAutofillFlow: autofill.pauseAutofillFlow,
      /** Resume the flow; see {@link PasskeyAutofillGates}. */
      resumeAutofillFlow: autofill.resumeAutofillFlow,
      /** See {@link PasskeyAutofillGates}. */
      isAutofillSigningIn: autofill.isAutofillSigningIn,
    }),
    [available, status, lastError, autofill],
  );
}

/**
 * Building block for modal passkey flows: a `run` callback that runs one
 * modal ceremony at a time, plus its `pending` state. See
 * {@link createPasskeyCeremonySlot}.
 */
export function usePasskeyCeremonySlot(options: {
  /**
   * The gates of the autofill flow of the page, or `null` when the page
   * runs none, which is the case of a settings page.
   */
  autofill: PasskeyAutofillGates | null;
}) {
  const slot = useMethodClient(createPasskeyCeremonySlot, options);
  const pending = useReadableStore(slot.pending);
  return {
    /** Run `fn` as the one modal ceremony of the page. */
    run: slot.run,
    /** `true` while a `run` call is running. */
    pending,
  };
}
