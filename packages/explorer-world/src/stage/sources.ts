/**
 * Where the stage's recordings come from: the live stream of the recorder,
 * and the recordings saved with the projects, to replay.
 *
 * @module
 */
import type { Event } from "../adapters/convexRecording.ts";
import { connectLive, LiveFeed, liveUrl } from "../live.ts";
import { PROJECTS } from "../project.ts";
import { rebuildLive, useStage } from "./store.ts";

const params = new URLSearchParams(
  typeof location === "undefined" ? "" : location.search,
);
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

/** A part of the client code from the structure map, with its own parts. */
export type ClientPart = {
  id: string;
  name: string;
  kind: string;
  file: string | null;
  children: ClientPart[];
};

/**
 * The modules of the structure map that run in the browser, each with the
 * parts it holds (its hooks and functions), for the client code district
 * that the project names (`clientMap` in its `stage.json`).
 */
export function clientTree(): ClientPart[] {
  const found = Object.entries(PROJECTS);
  const source = (found.find(([name]) => name === project) ?? found[0])?.[1];
  const parts = (source?.structure.parts ?? []) as unknown as {
    id: string;
    name: string;
    kind: string;
    parent?: string;
    runsIn?: string;
    source?: { file: string };
  }[];
  const browser = parts.filter((p) => p.runsIn === "browser");
  const modules = browser.filter((p) => p.kind === "module");
  return modules
    .map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      file: m.source?.file ?? null,
      children: browser
        .filter((p) => p.parent === m.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          file: p.source?.file ?? null,
          children: [],
        })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
