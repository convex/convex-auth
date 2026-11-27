import { create } from "zustand";
import { parseNdjson } from "./adapters/convexRecording.ts";
import { setActionEndpoint, takeControls } from "./controls.ts";
import {
  anchorTime,
  connectLive,
  LiveFeed,
  liveEdge,
  liveToken,
  liveUrl,
  nextStart,
  placedBehind,
  withToken,
} from "./live.ts";
import { nextStop, previousStop } from "./model/playback.ts";
import type { World } from "./model/world.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "./project.ts";
import { reportProblem } from "./problems.ts";

const params = new URLSearchParams(location.search);
const chosen = params.get("project");
const name =
  chosen && PROJECTS[chosen] ? chosen : (Object.keys(PROJECTS)[0] ?? "");
/** The project in the URL, ready to take recordings. */
export const project = prepareProject(PROJECTS[name]);

/** `?live=<url>`: the recorder's stream, for a recording still being made. */
let liveSource: URL | null = null;
try {
  liveSource = liveUrl(params.get("live"));
} catch (error) {
  reportProblem(error instanceof Error ? error.message : String(error));
}

/**
 * `?recording=<name>`: a saved recording of the project, shown only when
 * asked for by name. Without it and without `?live=`, the world is the map
 * alone, still.
 */
const recordingName = (() => {
  const asked = params.get("recording");
  if (asked === null) return null;
  if (asked in project.source.timelines) return asked;
  reportProblem(
    `No saved recording "${asked}"; the project has ${Object.keys(project.source.timelines).join(", ")}.`,
  );
  return null;
})();

/** Neither live nor a saved recording: the world waits for live mode. */
export const idle = !liveSource && recordingName === null;

/**
 * The world of the project in the URL (`?project=`), or the first one, with
 * the live recording at `?live=`, or the saved recording `?recording=`, or
 * none. Live, it is replaced as the recording grows: read it where it is
 * used, not once at the top of a module.
 */
export let world: World =
  liveSource || recordingName === null
    ? worldFromEvents(project, [], liveSource ? "live" : "none").world
    : worldFromEvents(
        project,
        parseNdjson(project.source.timelines[recordingName] ?? ""),
        recordingName,
      ).world;
export const projectName = name;

/** What the HUD shows of a live recording. */
export interface LiveStatus {
  url: string;
  connection: "connecting" | "open" | "ended" | "lost";
  /** Events received. */
  events: number;
  /** Runs that arrived late and fell before the run the playhead was in. */
  placedBehind: number;
  /**
   * Whether the lines written before the world connected are in. Until then
   * the world shows the newest state, still; after, what is new plays.
   */
  caughtUp: boolean;
}

export type Selection =
  | { type: "part"; id: string }
  | { type: "row"; table: string; id: string }
  | { type: "movement"; id: string }
  | { type: "run"; id: string }
  | { type: "op"; id: string }
  | { type: "cargo"; holder: string; table: string; row: string };

/** What is drawn over the world besides the selection. */
export interface Overlays {
  /** Every dependency, as a thin line. */
  links: boolean;
  /** The relations between top-level islands. */
  relations: boolean;
  /** Every unresolved dependency, as a stub. */
  unresolved: boolean;
}

interface PlaybackStore {
  time: number;
  playing: boolean;
  /** The viewer paused: what arrives live does not start playback. */
  held: boolean;
  speed: number;
  selected: Selection | null;
  /** The camera follows the action until the viewer takes the controls. */
  director: boolean;
  /** Bumped to ask the camera to fly somewhere. */
  flight: { target: "overview" | "home" | Selection; seq: number } | null;
  overlays: Overlays;
  /** Bumped when the world is rebuilt (a live recording grew). */
  version: number;
  /** Bumped when the map is laid out again; the scene mounts afresh. */
  layoutVersion: number;
  /** Null unless the world shows a live recording. */
  live: LiveStatus | null;
  /** Plays the newest run of a live recording. */
  skipToLive: () => void;
  setTime: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: (direction: 1 | -1) => void;
  setSpeed: (speed: number) => void;
  select: (selection: Selection | null) => void;
  setDirector: (on: boolean) => void;
  flyTo: (target: "overview" | "home" | Selection) => void;
  toggleOverlay: (name: keyof Overlays) => void;
}

const clamp = (t: number) => Math.min(Math.max(t, 0), world.timeline.duration);

export const usePlayback = create<PlaybackStore>((set, get) => ({
  time: 0,
  // Still on load: nothing plays until something new happens.
  playing: false,
  held: false,
  speed: 1,
  selected: null,
  // The camera stays where the viewer put it; it follows only when asked (F).
  director: false,
  flight: null,
  overlays: { links: false, relations: true, unresolved: false },
  version: 0,
  layoutVersion: 0,
  live: liveSource
    ? {
        url: liveSource.href,
        connection: "connecting",
        events: 0,
        placedBehind: 0,
        caughtUp: false,
      }
    : null,
  skipToLive: () =>
    set({ time: liveEdge(world.timeline), playing: true, held: false }),
  setTime: (t) => set({ time: clamp(t) }),
  play: () => {
    const live = get().live;
    // A live recording that is still growing does not start over at its end.
    if (
      get().time >= world.timeline.duration &&
      !(live && live.connection !== "ended")
    )
      set({ time: 0 });
    set({ playing: true, held: false });
  },
  pause: () => set({ playing: false, held: true }),
  toggle: () => (get().playing ? get().pause() : get().play()),
  step: (direction) =>
    set((s) => ({
      playing: false,
      held: true,
      time:
        direction === 1
          ? nextStop(world.timeline, s.time)
          : previousStop(world.timeline, s.time),
    })),
  setSpeed: (speed) => set({ speed }),
  select: (selected) => set({ selected }),
  setDirector: (director) => set({ director }),
  flyTo: (target) =>
    set((s) => ({
      director: false,
      flight: { target, seq: (s.flight?.seq ?? 0) + 1 },
    })),
  toggleOverlay: (name) =>
    set((s) => ({ overlays: { ...s.overlays, [name]: !s.overlays[name] } })),
}));

let cached: { time: number; state: ReturnType<typeof world.stateAt> } | null =
  null;

/** The world at the current time, computed once per time value. */
export function currentState() {
  const { time } = usePlayback.getState();
  if (!cached || cached.time !== time)
    cached = { time, state: world.stateAt(time) };
  return cached.state;
}

/** Seconds of quiet the playhead keeps before something new it jumps to. */
const LEAD_IN = 0.3;

/**
 * Replaces the world with `next`, a rebuild of the same recording with more
 * events. The playhead keeps its place in the run it is in (see `live.ts`).
 */
export function replaceWorld(next: World, relaidOut: boolean) {
  const s = usePlayback.getState();
  const before = world.timeline;
  const behind = placedBehind(before, s.time, next.timeline);
  // Before the world caught up, what arrives is the past: the playhead stays
  // at the newest state. After, what arrives is new: a playhead waiting at
  // the end plays it, unless the viewer paused.
  const caughtUp = s.live?.caughtUp ?? true;
  const atEnd = s.time >= before.duration - 1e-6;
  const grew = next.timeline.duration > before.duration + 1e-6;
  const resumes = Boolean(s.live && caughtUp && atEnd && grew && !s.held);
  // A world at rest that something new reaches goes straight to it: the
  // pause before it (a person who had not pressed anything) is not played.
  const time = !caughtUp
    ? next.timeline.duration
    : resumes
      ? Math.max(
          s.time,
          nextStart(next.timeline, before.duration - 1e-6) - LEAD_IN,
        )
      : anchorTime(before, s.time, next.timeline);
  world = next;
  cached = null;
  usePlayback.setState({
    ...(resumes && !s.playing ? { playing: true } : {}),
    time,
    version: s.version + 1,
    layoutVersion: s.layoutVersion + (relaidOut ? 1 : 0),
    live: s.live && {
      ...s.live,
      placedBehind: s.live.placedBehind + behind,
    },
  });
}

/** When each rebuild was made and first drawn, for measuring the lag. */
export const liveTrace: {
  /** The events of the stream, in order. */
  events: readonly unknown[];
  /** Per event of the stream, in order: when the world received it. */
  received: number[];
  /**
   * Per rebuild: how many events it held, when it was built, how long the
   * rebuild took (ms), and when the next frame began.
   */
  builds: {
    events: number;
    builtAt: number;
    ms: number;
    drawnAt: number | null;
  }[];
} = { events: [], received: [], builds: [] };

if (liveSource) {
  const token = liveToken(location.hash);
  const stream = withToken(liveSource, token);
  setActionEndpoint(liveSource, token);
  const feed = new LiveFeed();
  liveTrace.received = feed.arrivals;
  liveTrace.events = feed.events;
  let lastBuild = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Rebuilding takes a few ms; at most one every MIN_GAP ms.
  const MIN_GAP = 100;
  const rebuild = () => {
    timer = null;
    lastBuild = performance.now();
    const started = lastBuild;
    const { world: next, relaidOut } = worldFromEvents(
      project,
      feed.events,
      "live",
      world,
    );
    replaceWorld(next, relaidOut);
    liveTrace.builds.push({
      events: feed.events.length,
      builtAt: Date.now(),
      ms: performance.now() - started,
      drawnAt: null,
    });
    usePlayback.setState((s) => ({
      live: s.live && { ...s.live, events: feed.events.length },
    }));
  };
  connectLive(stream, feed, {
    onCaughtUp: () => {
      if (usePlayback.getState().live?.caughtUp) return;
      if (timer !== null) clearTimeout(timer);
      rebuild();
      usePlayback.setState((s) => ({
        time: world.timeline.duration,
        live: s.live && { ...s.live, caughtUp: true },
      }));
    },
    onControls: takeControls,
    onLines: () => {
      if (timer !== null) return;
      timer = setTimeout(
        rebuild,
        Math.max(0, lastBuild + MIN_GAP - performance.now()),
      );
    },
    onStatus: (connection) => {
      if (connection === "lost")
        reportProblem(
          `The live recording at ${liveSource.href} cannot be reached${token === null ? " (the link has no #token=: open the link that explorer:live printed)" : ""}; the world keeps what it received.`,
        );
      usePlayback.setState((s) => ({
        live: s.live && { ...s.live, connection },
      }));
    },
  });
}

/** Hover state, outside React so hovering does not re-render the scene. */
export const hover = { label: "" };
