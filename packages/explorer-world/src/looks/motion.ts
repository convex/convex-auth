/**
 * The sample motion, as a pure function of time: a press leaves the button on
 * the screen, travels down to the Auth client, goes out through the exit,
 * comes back, and two tokens drop into localStorage. Scrubbing in either
 * direction is just calling it with another time.
 */
import { Vector3 } from "three";
import {
  AUTH_TOP,
  LOCAL_STORAGE,
  ROUTES,
  SLOTS,
  type RouteName,
} from "./layout.ts";

export const DURATION = 6;

export type Frame = {
  /** The thing travelling, or null when nothing is. */
  mover: {
    position: Vector3;
    kind: "request" | "response";
    /** 0..1: fades at the exit. */
    opacity: number;
    route: RouteName;
  } | null;
  /** One per slot of localStorage: where its token is, if it exists yet. */
  tokens: ({ position: Vector3; settled: boolean } | null)[];
  /** The button on the screen is pressed. */
  pressed: boolean;
  /** The thing the motion is at, to light it. */
  active: string | null;
  /** The route the motion is on, to light it. */
  route: RouteName | null;
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 0 at a, 1 at b. */
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const ease = (x: number) => x * x * (3 - 2 * x);

// The beats, in seconds.
const PRESS_END = 0.35;
const DOWN_END = 1.7;
const OUT_START = 2.0;
const OUT_END = 3.1;
const BACK_START = 3.6;
const BACK_END = 4.6;
const STORE_END = 5.5;

export const BEATS = [
  { at: 0, text: "Log in is pressed" },
  { at: PRESS_END, text: "The page asks the Auth client to sign in" },
  { at: OUT_START, text: "The Auth client calls Convex" },
  { at: BACK_START, text: "Convex answers with tokens" },
  { at: BACK_END, text: "The tokens are kept in localStorage" },
];

export function beatAt(t: number): string {
  let text = BEATS[0].text;
  for (const b of BEATS) if (t >= b.at) text = b.text;
  return text;
}

export function frameAt(time: number): Frame {
  const t = Math.min(DURATION, Math.max(0, time));
  const frame: Frame = {
    mover: null,
    tokens: SLOTS.map(() => null),
    pressed: t < PRESS_END,
    active: null,
    route: null,
  };
  const on = (route: RouteName, u: number) =>
    ROUTES[route].getPointAt(clamp01(u));

  if (t < DOWN_END) {
    frame.mover = {
      position: on("press", ease(span(t, PRESS_END * 0.4, DOWN_END))),
      kind: "request",
      opacity: 1,
      route: "press",
    };
    frame.route = "press";
    if (t > DOWN_END - 0.3) frame.active = "authClient";
  } else if (t < OUT_START) {
    frame.mover = {
      position: AUTH_TOP.clone(),
      kind: "request",
      opacity: 1,
      route: "press",
    };
    frame.active = "authClient";
  } else if (t < BACK_START) {
    const u = ease(span(t, OUT_START, OUT_END));
    frame.mover = {
      position: on("out", u),
      kind: "request",
      opacity: 1 - span(t, OUT_END - 0.25, OUT_END),
      route: "out",
    };
    frame.route = "out";
    if (t > OUT_END - 0.3) frame.active = "convex";
  } else if (t < BACK_END) {
    const u = ease(span(t, BACK_START, BACK_END));
    frame.mover = {
      position: on("out", 1 - u),
      kind: "response",
      opacity: span(t, BACK_START, BACK_START + 0.25),
      route: "out",
    };
    frame.route = "out";
    frame.active = t < BACK_START + 0.3 ? "convex" : null;
    if (t > BACK_END - 0.3) frame.active = "authClient";
  }

  // The tokens: carried from the Auth client, then dropped into their slots.
  if (t >= BACK_END) {
    frame.route = t < STORE_END ? "store" : null;
    frame.active = t < STORE_END ? "localStorage" : null;
    SLOTS.forEach((slot, i) => {
      // The second token leaves a moment after the first.
      const start = BACK_END + i * 0.18;
      const u = ease(span(t, start, STORE_END - 0.35 + i * 0.18));
      const rest = new Vector3(
        LOCAL_STORAGE.position[0] + slot.offset[0],
        LOCAL_STORAGE.size[1] * 0.45,
        LOCAL_STORAGE.position[2] + slot.offset[2],
      );
      if (t < start) {
        frame.tokens[i] = { position: AUTH_TOP.clone(), settled: false };
        return;
      }
      const p = on("store", Math.min(u / 0.8, 1));
      // The last fifth drops straight down into the slot.
      const drop = clamp01((u - 0.8) / 0.2);
      p.lerp(rest, ease(drop));
      p.x += slot.offset[0] * Math.min(u / 0.8, 1) * (1 - drop);
      frame.tokens[i] = { position: p, settled: u >= 1 };
    });
  }
  return frame;
}
