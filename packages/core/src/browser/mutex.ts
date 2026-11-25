/**
 * A cross-context mutex used to serialize token refreshes so that concurrent
 * callers (multiple tabs, or several components racing on mount) collapse to a
 * single refresh instead of each rotating the refresh token and fighting over
 * the result.
 *
 * When the browser exposes the Web Locks API (`navigator.locks`) it is a true
 * cross-tab lock.
 *
 * Otherwise we fall back to an in-process queue, which still serializes
 * callers within a single JS realm (enough for tests and runtimes without Web
 * Locks). That doesn't serialize across tabs, so there is a race condition,
 * although it is narrowed by the grace window and shared token storage. This
 * is currently accepted since every major browser has Web Locks.
 */

// TODO: update client refresh code to use compare-and-swap to avoid concurrent
// refreshes overwriting each other.

/**
 * Run `callback` while holding the lock named `key`, resolving to its result.
 * Only one callback per key runs at a time.
 */
export async function runWithMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks !== undefined
    ? await locks.request(key, callback)
    : await manualMutex(key, callback);
}

type MutexState = {
  currentlyRunning: Promise<void> | null;
  waiting: Array<() => Promise<void>>;
};

const mutexes = new Map<string, MutexState>();

function manualMutex<T>(key: string, callback: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueue(key, () => callback().then(resolve, reject));
  });
}

function enqueue(key: string, callback: () => Promise<void>) {
  const mutex = getMutex(key);
  if (mutex.currentlyRunning === null) {
    mutex.currentlyRunning = callback().finally(() => {
      mutex.currentlyRunning = null;
      const next = mutex.waiting.shift();
      if (next !== undefined) {
        enqueue(key, next);
      }
    });
  } else {
    mutex.waiting.push(callback);
  }
}

function getMutex(key: string): MutexState {
  let mutex = mutexes.get(key);
  if (mutex === undefined) {
    mutex = { currentlyRunning: null, waiting: [] };
    mutexes.set(key, mutex);
  }
  return mutex;
}
