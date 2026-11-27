/**
 * The sample motion of the vast sample, as a pure function of time: "Log in"
 * is pressed on the screen; the submit goes down to the page's button, to
 * `LogIn` in the app's code, to the sign-in hook of the Convex Auth client,
 * out along the WebSocket to the Convex backend, and back to
 * `AuthClient.setSession`, which writes the two tokens through
 * `NamespacedStorage.set` into their keys of localStorage. Scrubbing in
 * either direction is calling it with another time.
 */
import { CatmullRomCurve3, Vector3 } from "three";
import type { V3 } from "../layout.ts";
import {
  GATES,
  JWT_KEY,
  REFRESH_KEY,
  SCREEN_BUTTON,
  WEBSOCKET,
  piece,
  topOf,
} from "./world.ts";

export const DURATION = 10.5;

const v = (p: V3, dy = 0) => new Vector3(p[0], p[1] + dy, p[2]);
const curve = (...points: Vector3[]) =>
  new CatmullRomCurve3(points, false, "centripetal");

/** A hop from a to b, rising in the middle by a share of the distance. */
function hop(a: Vector3, b: Vector3, rise = 0.28): CatmullRomCurve3 {
  const d = a.distanceTo(b);
  const mid = a.clone().lerp(b, 0.5);
  mid.y = Math.max(a.y, b.y) + Math.min(40, d * rise);
  return curve(a, mid, b);
}

const lift = 1.6;
export const STOPS = {
  submit: v(topOf(piece("page:submit")), lift),
  logIn: v(topOf(piece("appCode:routes/logIn.tsx#LogIn")), lift),
  signIn: v(
    topOf(
      piece(
        "authClient:methods/username-password/react.tsx#useSignInWithUsernamePassword",
      ),
    ),
    lift,
  ),
  setSession: v(
    topOf(piece("authClient:browser/sessionManager.ts#AuthClient.setSession")),
    lift,
  ),
  storageSet: v(
    topOf(piece("authClient:browser/storage.ts#NamespacedStorage.set")),
    lift,
  ),
  port: v(topOf(WEBSOCKET), 4),
  gate: v(GATES[0].position, 22),
  jwt: v(topOf(JWT_KEY.children[0]), 1.2),
  refresh: v(topOf(REFRESH_KEY.children[0]), 1.2),
};

const S = STOPS;
/** The legs of the motion, each a route. */
export const ROUTES = {
  press: curve(
    v(SCREEN_BUTTON),
    new Vector3(SCREEN_BUTTON[0], SCREEN_BUTTON[1] - 30, SCREEN_BUTTON[2] + 10),
    new Vector3(S.submit.x, 24, S.submit.z - 6),
    S.submit.clone(),
  ),
  submit: hop(S.submit, S.logIn),
  call: hop(S.logIn, S.signIn),
  out: curve(
    S.signIn.clone(),
    new Vector3((S.signIn.x + S.port.x) / 2, 30, S.port.z),
    S.port.clone(),
    new Vector3(S.port.x + 120, 18, S.port.z),
    S.gate.clone(),
  ),
  back: curve(
    S.gate.clone(),
    new Vector3(S.port.x + 120, 18, S.port.z + 2),
    S.port.clone().add(new Vector3(0, 0, 2)),
    new Vector3((S.setSession.x + S.port.x) / 2, 30, S.port.z + 2),
    S.setSession.clone(),
  ),
  write: hop(S.setSession, S.storageSet, 0.5),
  jwt: hop(S.storageSet, S.jwt),
  refresh: hop(S.storageSet, S.refresh),
};
export type RouteName = keyof typeof ROUTES;

type Leg = {
  route: RouteName;
  start: number;
  end: number;
  kind: "request" | "response";
  /** The thing the leg arrives at, lit as it arrives. */
  to: string;
  beat: string;
};

const LEGS: Leg[] = [
  {
    route: "press",
    start: 0.4,
    end: 1.8,
    kind: "request",
    to: "page:submit",
    beat: "Log in is pressed: the form submits",
  },
  {
    route: "submit",
    start: 2.0,
    end: 3.0,
    kind: "request",
    to: "appCode:routes/logIn.tsx#LogIn",
    beat: "The form's onSubmit in LogIn",
  },
  {
    route: "call",
    start: 3.2,
    end: 4.2,
    kind: "request",
    to: "authClient:methods/username-password/react.tsx#useSignInWithUsernamePassword",
    beat: "LogIn calls signIn of useSignInWithUsernamePassword",
  },
  {
    route: "out",
    start: 4.4,
    end: 6.0,
    kind: "request",
    to: "convexBackend",
    beat: "The sign-in mutation goes out on the WebSocket",
  },
  {
    route: "back",
    start: 6.5,
    end: 8.0,
    kind: "response",
    to: "authClient:browser/sessionManager.ts#AuthClient.setSession",
    beat: "The backend answers with the tokens: AuthClient.setSession",
  },
  {
    route: "write",
    start: 8.2,
    end: 8.9,
    kind: "response",
    to: "authClient:browser/storage.ts#NamespacedStorage.set",
    beat: "setSession writes them through NamespacedStorage.set",
  },
];

/** The two tokens: from `NamespacedStorage.set` to their keys. */
const TOKENS = [
  { route: "jwt" as const, start: 9.0, end: 9.9, key: JWT_KEY.id },
  { route: "refresh" as const, start: 9.15, end: 10.05, key: REFRESH_KEY.id },
];

export const BEATS = [
  { at: 0, text: "Log in is pressed" },
  ...LEGS.map((l) => ({ at: l.start, text: l.beat })),
  {
    at: TOKENS[0].start,
    text: "The tokens land in their keys of localStorage",
  },
];

export function beatAt(t: number): string {
  let text = BEATS[0].text;
  for (const b of BEATS) if (t >= b.at) text = b.text;
  return text;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 0 at a, 1 at b. */
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const ease = (x: number) => x * x * (3 - 2 * x);

export type Frame = {
  pressed: boolean;
  /** The request or response travelling, or null. */
  carrier: {
    position: Vector3;
    kind: "request" | "response";
    opacity: number;
  } | null;
  /** The route of the current leg, travelled up to u. */
  trail: { route: RouteName; u: number; kind: "request" | "response" } | null;
  /** The two tokens while they travel, else null. */
  tokens: ({ position: Vector3 } | null)[];
  /** How far each key of localStorage exists: 0 before it is set, 1 after. */
  keys: Record<string, number>;
  /** The thing the motion is at. */
  active: string | null;
  /** The district the motion is in or at. */
  activeDistrict: string | null;
};

const districtOf = (id: string | null) =>
  id === null ? null : id === "convexBackend" ? null : id.split(":")[0];

export function frameAt(time: number): Frame {
  const t = Math.min(DURATION, Math.max(0, time));
  const frame: Frame = {
    pressed: t < LEGS[0].start,
    carrier: null,
    trail: null,
    tokens: TOKENS.map(() => null),
    keys: Object.fromEntries(TOKENS.map((k) => [k.key, 0])),
    active: null,
    activeDistrict: null,
  };

  // The leg under way, or the one last ended (the carrier waits at its end).
  let leg: Leg | null = null;
  for (const l of LEGS) if (t >= l.start || l === LEGS[0]) leg = l;
  if (leg && t < TOKENS[0].start) {
    const u = ease(span(t, leg.start, leg.end));
    const kind = leg.kind;
    let opacity = 1;
    // It fades into the backend's gate and out of it.
    if (leg.route === "out") opacity = 1 - span(t, leg.end - 0.2, leg.end);
    if (leg.route === "back") opacity = span(t, leg.start, leg.start + 0.2);
    frame.carrier = {
      position: ROUTES[leg.route].getPointAt(u),
      kind,
      opacity,
    };
    frame.trail = { route: leg.route, u, kind };
    if (u > 0.9) frame.active = leg.to;
    else if (u < 0.1) {
      const before = LEGS[LEGS.indexOf(leg) - 1];
      frame.active = before ? before.to : null;
    }
  }

  TOKENS.forEach((k, i) => {
    if (t < k.start) return;
    const u = ease(span(t, k.start, k.end));
    frame.keys[k.key] = ease(span(t, k.end - 0.25, k.end));
    if (u < 1) frame.tokens[i] = { position: ROUTES[k.route].getPointAt(u) };
    if (u > 0.85 && t < k.end + 0.3) frame.active = k.key;
  });
  if (t >= TOKENS[0].start && frame.active === null && t < TOKENS[1].end)
    frame.active = "authClient:browser/storage.ts#NamespacedStorage.set";
  frame.activeDistrict = districtOf(frame.active);
  return frame;
}
