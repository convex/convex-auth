/**
 * Live mode: the world of a recording that is still being made.
 *
 * The recorder serves its timeline over Server-Sent Events as it writes it
 * (`record --serve`): every line so far, then each new one, then `end`. The
 * world keeps the events, and after each batch builds the recording again
 * from all of them, the same way it builds a saved one. Thus the world of a
 * live recording, once it ends, is the world of its file, and an event that
 * comes late or out of order lands where it belongs.
 *
 * Real runs take milliseconds and the world plays at human speed, so the
 * timeline grows ahead of the playhead: playback is a queue, played in order.
 * When the timeline is rebuilt, the playhead keeps its place in the run it
 * was in ({@link anchorTime}); a late run that falls before it is placed in
 * the past, and counted ({@link placedBehind}), rather than moving what is on
 * screen. A late write or step of the run on screen joins that run: if the
 * playhead is past the point where it plays, it shows at once.
 *
 * @module
 */
import type { Event } from "./adapters/convexRecording.ts";
import type { Timeline } from "./model/schedule.ts";
import type { World } from "./model/world.ts";

/** The events of a live recording as they arrive. */
export class LiveFeed {
  readonly events: Event[] = [];
  /** The id of the last line taken; lines arrive numbered from 0. */
  lastId = -1;
  ended = false;
  /** Lines that could not be read, skipped. */
  skipped = 0;
  /** When each event arrived, in ms since the epoch, by index in `events`. */
  readonly arrivals: number[] = [];

  /** Takes one line of the stream; false when it was already taken. */
  take(id: number, data: string): boolean {
    if (id <= this.lastId) return false;
    this.lastId = id;
    try {
      const event = JSON.parse(data) as Event;
      if (typeof event?.kind !== "string") throw new Error("no kind");
      this.events.push(event);
      this.arrivals.push(Date.now());
    } catch {
      this.skipped++;
    }
    return true;
  }
}

/**
 * Where the playhead goes when `before` is rebuilt as `after`: the same
 * offset into the same run, kept within that run. Before the first run, or
 * when the run is gone, the time itself.
 */
export function anchorTime(
  before: Timeline,
  time: number,
  after: Timeline,
): number {
  let chapter = null;
  for (const c of before.chapters) if (c.start <= time) chapter = c;
  if (!chapter) return Math.min(time, after.duration);
  const same = after.chapters.find((c) => c.run.id === chapter.run.id);
  if (!same) return Math.min(time, after.duration);
  return Math.min(
    same.start + (time - chapter.start),
    same.end,
    after.duration,
  );
}

/** How many runs new in `after` fall before the run the playhead is in. */
export function placedBehind(
  before: Timeline,
  time: number,
  after: Timeline,
): number {
  const known = new Set(before.chapters.map((c) => c.run.id));
  let current = -1;
  before.chapters.forEach((c, i) => {
    if (c.start <= time) current = i;
  });
  if (current < 0) return 0;
  const at = after.chapters.findIndex(
    (c) => c.run.id === before.chapters[current].run.id,
  );
  return after.chapters
    .slice(0, Math.max(at, 0))
    .filter((c) => !known.has(c.run.id)).length;
}

/** How far the playhead is behind the newest thing the world knows. */
export function behindLive(
  timeline: Timeline,
  time: number,
): { seconds: number; runs: number } {
  return {
    seconds: Math.max(0, timeline.duration - time),
    runs: timeline.chapters.filter((c) => c.start > time + 1e-6).length,
  };
}

/** Where "skip to live" puts the playhead: the start of the newest run. */
export function liveEdge(timeline: Timeline): number {
  const last = timeline.chapters[timeline.chapters.length - 1];
  return last ? last.start : timeline.duration;
}

/**
 * The URL of the stream from `?live=`, which must be on this machine: the
 * world makes no request elsewhere. Null when absent; throws when invalid.
 */
export function liveUrl(param: string | null): URL | null {
  if (param === null) return null;
  const url = new URL(param);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      `?live= must be the recorder's stream on this machine, such as http://127.0.0.1:5199/timeline, not ${param}.`,
    );
  return url;
}

/**
 * The token of this run, from the link's fragment (`#token=`), which the
 * browser sends to no server. Null without one.
 */
export function liveToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

/** The URL of the stream with the token, which the stream requires. */
export function withToken(url: URL, token: string | null): URL {
  const out = new URL(url);
  if (token !== null) out.searchParams.set("token", token);
  return out;
}

export type LiveConnection = {
  /** Closes the stream. */
  close: () => void;
};

/**
 * Reads the stream at `url` with `EventSource`. Until it first connects, it
 * tries again every 500 ms; after, the browser reconnects on its own and
 * resumes after the last line it got. `onLines` gets each batch; a batch ends
 * when the browser has no more messages queued. `onCaughtUp` is called once
 * the lines written before the world connected are in (the past), and
 * `onControls` with each state of the recorder's controls.
 */
export function connectLive(
  url: URL,
  feed: LiveFeed,
  handlers: {
    onLines: () => void;
    onStatus: (status: "connecting" | "open" | "ended" | "lost") => void;
    onCaughtUp?: () => void;
    onControls?: (state: unknown) => void;
  },
): LiveConnection {
  let source: EventSource;
  let opened = false;
  let closed = false;
  let queued = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  handlers.onStatus("connecting");
  const open = () => {
    source = new EventSource(url);
    source.onopen = () => {
      opened = true;
      handlers.onStatus("open");
    };
    source.onmessage = (message) => {
      if (!feed.take(Number(message.lastEventId), message.data)) return;
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        handlers.onLines();
      }, 0);
    };
    source.addEventListener("caughtup", () => {
      // After the lines queued before it: the batch they make goes first.
      setTimeout(() => handlers.onCaughtUp?.(), 0);
    });
    source.addEventListener("actions", (message) => {
      try {
        handlers.onControls?.(JSON.parse((message as MessageEvent).data));
      } catch {
        // Not JSON: ignored.
      }
    });
    source.addEventListener("end", () => {
      feed.ended = true;
      source.close();
      handlers.onLines();
      handlers.onStatus("ended");
    });
    source.onerror = () => {
      if (feed.ended || closed) return;
      if (!opened) {
        // The world can open before the recorder serves: try again soon,
        // sooner than the browser's own retry.
        source.close();
        retry = setTimeout(open, 500);
        return;
      }
      // Once open, the browser reconnects on its own and resumes after the
      // last line it got.
      handlers.onStatus(
        source.readyState === EventSource.CLOSED ? "lost" : "connecting",
      );
    };
  };
  open();
  return {
    close: () => {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      source.close();
    },
  };
}

/**
 * What a viewer can tell apart in a world: its runs with their steps,
 * writes, cargo and page items (an unlinked call is a page item), the rows it
 * started with, the parts of its map, what it counted and left unplaced, and
 * its timeline. Two worlds with equal summaries show the same thing.
 */
export function summarize(world: World) {
  const { recording, timeline } = world;
  return {
    runs: recording.runs.map((r) => ({
      id: r.id,
      function: r.function,
      caller: r.caller,
      steps: r.steps,
      writes: r.writes,
      carriesIn: r.carriesIn,
      carriesOut: r.carriesOut,
      before: r.before,
      after: r.after,
      scheduledBy: r.scheduledBy,
    })),
    snapshot: recording.snapshot,
    unplaced: recording.unplaced,
    events: recording.events,
    parts: world.graph.parts.map((p) => p.id),
    duration: timeline.duration,
    movements: timeline.movements.map((m) => [m.id, m.kind, m.from, m.to]),
  };
}
