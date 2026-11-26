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
export type LogPage = { entries: unknown[]; newCursor: number };

/** Fetches the page of the log stream after `cursor`. */
export type FetchLogPage = (cursor: number) => Promise<LogPage>;

/**
 * The entries of the first response that the recorder keeps: the ones that
 * finished at or after `startedAt` (ms), plus the last `history` of the ones
 * before. The log stream starts with the recent entries of the deployment.
 */
export function firstEntries(
  entries: readonly unknown[],
  startedAt: number,
  history: number,
): unknown[] {
  const isNew = (entry: unknown) => {
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    return typeof timestamp !== "number" || timestamp * 1000 >= startedAt;
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
    private readonly startedAt: number,
    private readonly history = 0,
  ) {}

  /** The entries of the next page. Waits while the deployment is idle. */
  async next(): Promise<unknown[]> {
    const page = await this.fetchPage(this.cursor);
    this.cursor = page.newCursor;
    if (this.first) {
      this.first = false;
      return firstEntries(page.entries, this.startedAt, this.history);
    }
    return page.entries;
  }
}
