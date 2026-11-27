/**
 * Where the stage's recordings come from: the live stream of the recorder,
 * and the recordings saved with the projects, to replay.
 *
 * @module
 */
import type { Event } from "../adapters/convexRecording.ts";
import { connectLive, LiveFeed, liveUrl } from "../live.ts";
import { rebuildLive, useStage } from "./store.ts";

const params = new URLSearchParams(location.search);
const project = params.get("project");

/** The saved recordings of the project, by name, loaded when chosen. */
export const RECORDINGS: Record<string, () => Promise<string>> = (() => {
  const found = import.meta.glob<string>(
    "../../projects/*/recording-*.ndjson",
    {
      query: "?raw",
      import: "default",
    },
  );
  const out: Record<string, () => Promise<string>> = {};
  const entries = Object.entries(found);
  const dirs = [...new Set(entries.map(([p]) => p.split("/").slice(-2)[0]))];
  const chosen = project && dirs.includes(project) ? project : dirs[0];
  for (const [path, load] of entries) {
    const [dir, file] = path.split("/").slice(-2);
    if (dir !== chosen) continue;
    out[file.replace(/^recording-|\.ndjson$/g, "")] = load;
  }
  return out;
})();

/** What a project says of its stage: the names of the exits and client code. */
export function projectLabels(): Partial<
  ReturnType<typeof useStage.getState>["labels"]
> {
  const found = import.meta.glob<Record<string, unknown>>(
    "../../projects/*/stage.json",
    { eager: true, import: "default" },
  );
  const entries = Object.entries(found);
  const pick =
    entries.find(([p]) => p.split("/").slice(-2)[0] === project) ?? entries[0];
  return (pick?.[1] ?? {}) as Partial<
    ReturnType<typeof useStage.getState>["labels"]
  >;
}

const feed = new LiveFeed();

/** The events of the live recording so far. */
export const liveEvents = (): Event[] => feed.events;

/** For checks: when each event arrived, and the feed. */
export const liveFeed = feed;

/**
 * Connects to the recorder's stream from `?live=`, and rebuilds the live
 * model after each batch, at most every 50 ms.
 */
export function startLive(): void {
  let url: URL | null;
  try {
    url = liveUrl(params.get("live"));
  } catch (error) {
    useStage.getState().setLiveStatus("lost");
    throw error;
  }
  if (url === null) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const rebuild = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      rebuildLive(feed.events);
    }, 50);
  };
  connectLive(url, feed, {
    onLines: rebuild,
    onStatus: (status) => useStage.getState().setLiveStatus(status),
  });
}
