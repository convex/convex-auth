/**
 * Reads the function logs of a deployment from its log stream,
 * `GET /api/stream_function_logs?cursor=<ms>`, the endpoint behind
 * `npx convex logs`.
 *
 * The recorder does not run `npx convex logs`: that command keeps none of the
 * entries of its first response, and on a deployment with no recent logs
 * the first response is a long poll that returns the next function run.
 * Thus `npx convex logs` drops the first run after it starts.
 *
 * @module
 */

/** One response of the log stream. */
export type LogPage = {
  entries: unknown[];
  /** The timestamp of the last entry, in ms of the deployment's clock. */
  newCursor: number;
};

/**
 * One response of the log stream, with what the recorder knows of the
 * deployment's clock when it arrived.
 */
export type TimedLogPage = LogPage & {
  /**
   * The `Date` header of the response, in ms: the deployment's clock,
   * rounded down to the second. Null when the response has none.
   */
  date: number | null;
  /** When the response arrived, in ms of the recorder's clock. */
  receivedAt: number;
};

/** Fetches the page of the log stream after `cursor`. */
export type FetchLogPage = (cursor: number) => Promise<TimedLogPage>;

/**
 * The time of the deployment's clock that matches `startedAt` of the
 * recorder's clock, from the `Date` header of a response.
 *
 * The header is rounded down to the second and is written before the
 * response travels, thus the result is at most the true time and at most
 * about a second plus the latency earlier. An entry that finished after the
 * start is never classed as earlier; one that finished up to about a second
 * before the start can be classed as after it. Without the header, the
 * recorder's clock stands in for the deployment's: right for a local
 * deployment, off by the skew between the clocks for a cloud one.
 */
export function deploymentStart(
  startedAt: number,
  date: number | null,
  receivedAt: number,
): number {
  return date === null ? startedAt : startedAt + (date - receivedAt);
}

/**
 * The entries of the first response that the recorder keeps: the ones that
 * finished at or after `start` (ms, of the deployment's clock), plus the last
 * `history` of the ones before. The log stream starts with the recent entries
 * of the deployment.
 */
export function firstEntries(
  entries: readonly unknown[],
  start: number,
  history: number,
): unknown[] {
  const isNew = (entry: unknown) => {
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    return typeof timestamp !== "number" || timestamp * 1000 >= start;
  };
  const before = entries.filter((entry) => !isNew(entry));
  return [
    ...(history > 0 ? before.slice(-history) : []),
    ...entries.filter(isNew),
  ];
}

/**
 * Reads the log stream page by page, keeping every entry that finishes after
 * the start of the recorder.
 */
export class LogPoller {
  private cursor = 0;
  private first = true;

  constructor(
    private readonly fetchPage: FetchLogPage,
    /** When the recorder started, in ms of the recorder's clock. */
    private readonly startedAt: number,
    private readonly history = 0,
  ) {}

  /** The entries of the next page. Waits while the deployment is idle. */
  async next(): Promise<unknown[]> {
    const page = await this.fetchPage(this.cursor);
    this.cursor = page.newCursor;
    if (this.first) {
      this.first = false;
      return firstEntries(
        page.entries,
        deploymentStart(this.startedAt, page.date, page.receivedAt),
        this.history,
      );
    }
    return page.entries;
  }
}
