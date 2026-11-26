/**
 * Links each call that the page made to its run on the server.
 *
 * The sync protocol and the HTTP API carry no id that the function logs
 * share: the `requestId` of a socket message is the client's counter, and the
 * `requestId` of a run is the server's. The link is found from what both
 * sides know:
 *
 * - A mutation over the socket that succeeded: the response carries the
 *   commit time (`ts`), which falls in the window `[time, endTime]` of the
 *   run on the deployment's own clock. No clock alignment is needed, and the
 *   writes of the run carry the same `ts`.
 * - Any other call: the run of the same function, from the same caller
 *   (`SyncWorker` for the socket, `HttpApi` for HTTP), that ran between the
 *   call and its result, once the deployment's clock is aligned with the
 *   recorder's (see `SocketReader.skew`), with {@link WINDOW_TOLERANCE_MS}
 *   to spare. A query answered from the cache keeps the start time of the
 *   execution that filled the cache, thus only its end must fall in the
 *   window.
 *
 * When several runs fit, the one whose number of log lines equals the one
 * the response gives wins; when that leaves more than one, the call stays
 * unlinked and lists them in `candidateRunIds`. A call that no run fits
 * stays unlinked with the reason. A run links to one call at most.
 *
 * The sync worker also runs a subscribed query again when the identity of
 * the socket changes; a run whose result equals the last one reaches the
 * page as nothing, thus such a run has no call.
 *
 * @module
 */
import type { CallEvent, RunEvent } from "./events.ts";
import { nanosToMs } from "./json.ts";
import { COMMIT_TOLERANCE_MS } from "./timeline.ts";

/**
 * How far, in ms, a run may start before the recorder saw the call leave the
 * page, or end after it saw the result arrive. The browser reports a frame a
 * little after it moves.
 */
export const WINDOW_TOLERANCE_MS = 10;

/** The `caller` of the runs that a transport causes. */
const CALLERS: Record<CallEvent["transport"], readonly string[]> = {
  socket: ["SyncWorker", "Websocket"],
  http: ["HttpApi"],
};

export type LinkContext = {
  /** The runs known so far. */
  runs: readonly RunEvent[];
  /** The number of log lines and step reports of each run. */
  lineCounts: ReadonlyMap<string, number>;
  /** Runs already linked to a call. */
  used: ReadonlySet<string>;
  /**
   * The offset of the deployment's clock from the recorder's, in ms; 0 when
   * unknown.
   */
  skew: number;
};

/** A copy of `call` with `runId`, `link`, and `unlinked` set. */
export function linkCall(call: CallEvent, context: LinkContext): CallEvent {
  const candidates = context.runs.filter(
    (run) =>
      run.componentPath === "" &&
      run.identifier === call.identifier &&
      run.udfType === call.udfType &&
      (CALLERS[call.transport].includes(run.caller) || run.caller === "") &&
      !context.used.has(run.id),
  );
  if (candidates.length === 0) {
    return unlinked(
      call,
      `no run of ${call.identifier} from the ${call.transport} in the logs` +
        (call.udfType === "Query" ? " (a cached result has no run)" : ""),
    );
  }
  if (call.commitTs !== null) {
    const commit = nanosToMs(call.commitTs);
    const fits = candidates.filter(
      (run) =>
        run.ok &&
        commit >= run.time - COMMIT_TOLERANCE_MS &&
        commit <= run.endTime + COMMIT_TOLERANCE_MS,
    );
    const chosen = pick(fits, call, context);
    if (chosen !== null) {
      return linked(call, chosen, "commitTs");
    }
    if (fits.length > 1) {
      return unlinked(call, `${fits.length} runs hold the commit time`, fits);
    }
  }
  const low = call.time + context.skew - WINDOW_TOLERANCE_MS;
  const high = call.endTime + context.skew + WINDOW_TOLERANCE_MS;
  const fits = candidates.filter(
    (run) =>
      (run.cachedResult || run.time >= low) &&
      run.endTime >= low &&
      run.endTime <= high &&
      run.ok === call.ok,
  );
  const chosen = pick(fits, call, context);
  if (chosen !== null) {
    return linked(call, chosen, "window");
  }
  return fits.length === 0
    ? unlinked(
        call,
        `no run of ${call.identifier} between the call and its result`,
      )
    : unlinked(
        call,
        `${fits.length} runs of ${call.identifier} between the call and its result`,
        fits,
      );
}

function linked(
  call: CallEvent,
  run: RunEvent,
  link: NonNullable<CallEvent["link"]>,
): CallEvent {
  return { ...call, runId: run.id, link, unlinked: null, candidateRunIds: [] };
}

function pick(
  fits: readonly RunEvent[],
  call: CallEvent,
  context: LinkContext,
): RunEvent | null {
  if (fits.length === 1) {
    return fits[0];
  }
  if (fits.length > 1 && call.logLineCount !== null) {
    const same = fits.filter(
      (run) => (context.lineCounts.get(run.id) ?? 0) === call.logLineCount,
    );
    if (same.length === 1) {
      return same[0];
    }
  }
  return null;
}

function unlinked(
  call: CallEvent,
  reason: string,
  candidates: readonly RunEvent[] = [],
): CallEvent {
  return {
    ...call,
    runId: null,
    link: null,
    unlinked: reason,
    candidateRunIds: candidates.map((run) => run.id),
  };
}
