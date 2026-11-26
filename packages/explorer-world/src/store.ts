import { create } from "zustand";
import { createWorld } from "./model/world.ts";
import { nextStop, previousStop } from "./model/playback.ts";

export const world = createWorld();

export type Selection =
  | { type: "region"; id: string }
  | { type: "function"; id: string }
  | { type: "table"; id: string }
  | { type: "row"; table: string; id: string }
  | { type: "movement"; id: string }
  | { type: "place"; id: string }
  | { type: "token"; holder: string; label: string };

interface PlaybackStore {
  time: number;
  playing: boolean;
  speed: number;
  selected: Selection | null;
  /** The camera follows the action until the viewer takes the controls. */
  director: boolean;
  /** Bumped to ask the camera to fly somewhere. */
  flight: { target: "overview" | Selection; seq: number } | null;
  setTime: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: (direction: 1 | -1) => void;
  setSpeed: (speed: number) => void;
  select: (selection: Selection | null) => void;
  setDirector: (on: boolean) => void;
  flyTo: (target: "overview" | Selection) => void;
}

const clamp = (t: number) => Math.min(Math.max(t, 0), world.timeline.duration);

export const usePlayback = create<PlaybackStore>((set, get) => ({
  time: 0,
  playing: true,
  speed: 1,
  selected: null,
  director: true,
  flight: null,
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
