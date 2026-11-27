/**
 * The state of the stage: the recording it shows (live by default, or a
 * replay), the time it shows it at, what is selected, and where the camera
 * is asked to go.
 *
 * The time is a function of the clock and of the viewer:
 *
 * - live: now (a little behind, so that an event has arrived when its time
 *   comes);
 * - held: a time the viewer dragged the handle to;
 * - playing: a replay running at real speed from where it was started.
 *
 * Letting go of the handle at the right end of a live recording returns to
 * live.
 *
 * @module
 */
import { create } from "zustand";
import {
  DEFAULT_LABELS,
  stageFromEvents,
  type StageLabels,
} from "../adapters/browserStage.ts";
import type { Event } from "../adapters/convexRecording.ts";
import { EMPTY_MODEL, type StageModel } from "./model.ts";

/** How far behind now live shows, in ms. */
export const LIVE_LAG_MS = 120;

export type Clock =
  | { mode: "live" }
  | { mode: "held"; time: number }
  | { mode: "playing"; from: number; at: number };

export type Selection =
  | { type: "element"; key: string }
  | { type: "slot"; area: "local" | "session" | "cookie"; key: string }
  | { type: "flight"; id: string }
  | { type: "thing"; id: string }
  | { type: "exit"; id: string };

export type Source =
  { kind: "live" } | { kind: "replay"; name: string; model: StageModel };

export type View = "default" | "screen";

type StageState = {
  labels: StageLabels;
  /** The live recording, rebuilt as it grows. */
  live: StageModel;
  liveStatus: "none" | "connecting" | "open" | "ended" | "lost";
  /** When the stage opened: the start of a live recording without events. */
  openedAt: number;
  source: Source;
  clock: Clock;
  selection: Selection | null;
  /** The camera's goal, and a counter that changes with each request. */
  view: View;
  flight: number;
  setLive: (model: StageModel) => void;
  setLiveStatus: (s: StageState["liveStatus"]) => void;
  hold: (time: number) => void;
  goLive: () => void;
  play: () => void;
  pause: () => void;
  replay: (name: string, model: StageModel) => void;
  select: (s: Selection | null) => void;
  fly: (view: View) => void;
};

export const useStage = create<StageState>((set, get) => ({
  labels: DEFAULT_LABELS,
  live: EMPTY_MODEL,
  liveStatus: "none",
  openedAt: Date.now(),
  source: { kind: "live" },
  clock: { mode: "live" },
  selection: null,
  view: "default",
  flight: 0,
  setLive: (live) => set({ live }),
  setLiveStatus: (liveStatus) => set({ liveStatus }),
  hold: (time) => set({ clock: { mode: "held", time } }),
  goLive: () =>
    set({ source: { kind: "live" }, clock: { mode: "live" }, selection: null }),
  play: () => {
    const s = get();
    const span = spanOf(s);
    let from = timeOf(s, Date.now());
    if (from >= span.end - 1) from = span.start;
    set({ clock: { mode: "playing", from, at: Date.now() } });
  },
  pause: () => {
    const s = get();
    set({ clock: { mode: "held", time: timeOf(s, Date.now()) } });
  },
  replay: (name, model) =>
    set({
      source: { kind: "replay", name, model },
      clock: { mode: "playing", from: model.start, at: Date.now() },
      selection: null,
    }),
  select: (selection) => set({ selection }),
  fly: (view) => set((s) => ({ view, flight: s.flight + 1 })),
}));

/** The recording shown. */
export function modelOf(s: Pick<StageState, "source" | "live">): StageModel {
  return s.source.kind === "live" ? s.live : s.source.model;
}

/** The span the time handle covers. */
export function spanOf(
  s: Pick<StageState, "source" | "live" | "openedAt">,
  now = Date.now(),
): { start: number; end: number } {
  if (s.source.kind === "replay") {
    const m = s.source.model;
    return { start: m.start, end: Math.max(m.end, m.start + 1) };
  }
  const start = s.live.counts && s.live.start > 0 ? s.live.start : s.openedAt;
  return { start: Math.min(start, now), end: now - LIVE_LAG_MS };
}

/** The time shown, at the clock time `now`. */
export function timeOf(
  s: Pick<StageState, "clock" | "source" | "live" | "openedAt">,
  now = Date.now(),
): number {
  const span = spanOf(s, now);
  switch (s.clock.mode) {
    case "live":
      return span.end;
    case "held":
      return Math.min(Math.max(s.clock.time, span.start), span.end);
    case "playing":
      return Math.min(s.clock.from + (now - s.clock.at), span.end);
  }
}

/** Builds the live model from all events so far. */
export function rebuildLive(events: Event[]): void {
  const s = useStage.getState();
  s.setLive(stageFromEvents(events, s.labels));
}
