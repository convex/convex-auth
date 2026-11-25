import { useCallback, useRef, useState } from "react";

/**
 * Track the in-flight state of the async calls of a hook.
 *
 * Normally an app does not start a call while another call of the same hook
 * runs: it disables the form while `pending` is true. As an extra layer of
 * safety for an app that does not, `pending` stays true until the last call
 * ends.
 *
 * @internal
 */
export function usePending() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(0);

  const track = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(true);
    try {
      return await work();
    } finally {
      if (--inFlight.current === 0) setPending(false);
    }
  }, []);
  return { pending, track };
}
