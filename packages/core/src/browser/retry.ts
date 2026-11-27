/**
 * Retry policy for the client's auth calls (session refresh, OAuth code
 * redemption). These calls commonly fail transiently on mobile when the app
 * is backgrounded mid-request and succeed once it returns to the foreground,
 * so a network error is worth a couple of retries before giving up.
 */

import { reportClientStep, type ClientOp } from "./steps.ts";

/** Retry after this much time (ms), based on the retry number. */
const RETRY_BACKOFF = [500, 2000];
const RETRY_JITTER = 100;

/**
 * Whether `error` looks like a fetch-level network failure. The message test
 * covers the wording used by Chromium, Firefox, and WebKit.
 */
function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /network|failed to fetch|load failed/i.test(error.message)
  );
}

/**
 * Run `fn`, retrying with backoff when it throws a network error. Any other
 * error, or a network error persisting past the last retry, is rethrown.
 * `op` is the operation that the `retry` step reports belong to.
 */
export async function retryOnNetworkError<T>(
  fn: () => Promise<T>,
  log?: (message: string) => void,
  op: ClientOp | null = null,
): Promise<T> {
  for (const [retry, backoff] of RETRY_BACKOFF.entries()) {
    try {
      return await fn();
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      const wait = backoff + RETRY_JITTER * Math.random();
      log?.(`network error, retry ${retry + 1} in ${wait}ms`);
      reportClientStep(
        "module:browser/retry",
        "retry",
        { attempt: retry + 1, waitMs: Math.round(wait) },
        op,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  // All backoffs are used up, so this last attempt's outcome is final
  // either way.
  return await fn();
}
