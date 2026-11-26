import { create } from "zustand";
import { nextStop, previousStop } from "./model/playback.ts";
import { loadProject, PROJECTS } from "./project.ts";

const params = new URLSearchParams(location.search);
const chosen = params.get("project");
const name =
  chosen && PROJECTS[chosen] ? chosen : (Object.keys(PROJECTS)[0] ?? "");

/** The world of the project in the URL (`?project=`), or the first one. */
export const world = loadProject(
  PROJECTS[name],
  params.get("recording") ?? undefined,
);
export const projectName = name;

export type Selection =
  | { type: "part"; id: string }
  | { type: "row"; table: string; id: string }
  | { type: "movement"; id: string }
  | { type: "run"; id: string }
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
  speed: number;
  selected: Selection | null;
  /** The camera follows the action until the viewer takes the controls. */
  director: boolean;
  /** Bumped to ask the camera to fly somewhere. */
  flight: { target: "overview" | Selection; seq: number } | null;
  overlays: Overlays;
  setTime: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: (direction: 1 | -1) => void;
  setSpeed: (speed: number) => void;
  select: (selection: Selection | null) => void;
  setDirector: (on: boolean) => void;
  flyTo: (target: "overview" | Selection) => void;
  toggleOverlay: (name: keyof Overlays) => void;
}

const clamp = (t: number) => Math.min(Math.max(t, 0), world.timeline.duration);

export const usePlayback = create<PlaybackStore>((set, get) => ({
  time: 0,
  playing: true,
  speed: 1,
  selected: null,
  director: true,
  flight: null,
  overlays: { links: false, relations: true, unresolved: false },
  setTime: (t) => set({ time: clamp(t) }),
  play: () => {
    if (get().time >= world.timeline.duration) set({ time: 0 });
    set({ playing: true });
  },
  pause: () => set({ playing: false }),
  toggle: () => (get().playing ? get().pause() : get().play()),
  step: (direction) =>
    set((s) => ({
      playing: false,
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

/** Hover state, outside React so hovering does not re-render the scene. */
export const hover = { label: "" };
