/**
 * The state of the stage: the recording it shows (live by default, or a
 * replay), the time it shows it at, what is selected, and where the camera
 * is asked to go.
 *
 * The time is a function of the clock and of the viewer:
 *
 * - live: now (a little behind, so that an event has arrived when its time
 *   comes). Times are shown times (`paths.ts`): a burst of steps is
 *   stretched, so live plays it at its shown pace, falling behind now while
 *   it does, and catches up at once when nothing is left to play;
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
import { shownOf } from "./paths.ts";

/** How far behind now live shows, in ms. */
export const LIVE_LAG_MS = 120;
/**
 * Live skips ahead once this much shown time has passed since the last
 * beat it played: the last movement has arrived by then.
 */
export const SETTLE_MS = 1600;
/** Live never falls further behind now than this, in shown ms. */
export const MOST_BEHIND_MS = 20_000;

export type Clock =
  | { mode: "live" }
  | { mode: "held"; time: number }
  | { mode: "playing"; from: number; at: number };

export type Selection =
  | { type: "element"; key: string }
  | { type: "slot"; area: "local" | "session" | "cookie"; key: string }
  | { type: "flight"; id: string }
  | { type: "thing"; id: string }
  | { type: "part"; id: string }
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
  goLive: () => {
    head = null;
    set({ source: { kind: "live" }, clock: { mode: "live" }, selection: null });
  },
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
  const end = shownOf(s.live.warp, now - LIVE_LAG_MS);
  return { start: Math.min(start, end), end };
}

/** Where live is: played at the shown pace, caught up when idle. */
let head: { shown: number; wall: number } | null = null;

/** The index of the first beat after `t`. */
function beatAfter(model: StageModel, t: number): number {
  const b = model.beats;
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The time live shows at the clock time `now`: it moves at the shown pace
 * from where it was, never past the shown time of now. When the last beat
 * it played is more than {@link SETTLE_MS} behind it, nothing is moving:
 * it skips the quiet to the next beat, or to now.
 */
export function liveTime(model: StageModel, end: number, now: number): number {
  let t = head ? head.shown + Math.max(0, now - head.wall) : end;
  t = Math.min(t, end);
  const i = beatAfter(model, t);
  const prev = i > 0 ? model.beats[i - 1].time : -Infinity;
  if (t - prev > SETTLE_MS)
    t = i < model.beats.length ? Math.min(end, model.beats[i].time) : end;
  t = Math.max(t, end - MOST_BEHIND_MS);
  if (!head || now >= head.wall) head = { shown: t, wall: now };
  return t;
}

/** The time shown, at the clock time `now`. */
export function timeOf(
  s: Pick<StageState, "clock" | "source" | "live" | "openedAt">,
  now = Date.now(),
): number {
  const span = spanOf(s, now);
  switch (s.clock.mode) {
    case "live":
      return s.source.kind === "live"
        ? liveTime(s.live, span.end, now)
        : span.end;
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
