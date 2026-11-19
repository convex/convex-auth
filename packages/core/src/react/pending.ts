import { useCallback, useRef, useState } from "react";

/**
 * Track the in-flight state of the async calls of a hook.
 *
 * Normally an app does not start a call while another call of the same hook
 * runs: it disables the form while `pending` is true. This hook is an extra
 * layer of safety for an app that does not:
 *
 * - `pending` stays true until the last call ends.
 * - `track` gives each call a `claimStorage` function. A call that stores a
 *   secret calls it first, and stores the secret only when it returns
 *   `true`. It returns `false` when a newer call already stored its secret.
 *   Calls can end out of order, and without this check an older call can
 *   replace the secret of a newer email, so that the link in the newer email
 *   fails. A newer call that fails stores nothing, thus it does not stop an
 *   older call from storing its secret.
 *
 * @internal
 */
export function usePending() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(0);
  // The number of the last call that started.
  const lastStarted = useRef(0);
  // The number of the newest call that stored its secret.
  const lastStored = useRef(0);

  const track = useCallback(
    async <T>(
      work: (claimStorage: () => boolean) => Promise<T>,
    ): Promise<T> => {
      const call = ++lastStarted.current;
      inFlight.current++;
      setPending(true);
      try {
        return await work(() => {
          if (call < lastStored.current) return false;
          lastStored.current = call;
          return true;
        });
      } finally {
        if (--inFlight.current === 0) setPending(false);
      }
    },
    [],
  );
  return { pending, track };
}
