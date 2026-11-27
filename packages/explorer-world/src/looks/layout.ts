/**
 * Where the sample scene's things stand, and the routes the sample motion
 * takes. Positions only: what anything looks like is up to the look.
 *
 * The screen stands at the back; everything else is below and in front of
 * it, between it and the viewer. Nothing stands behind it.
 */
import { CatmullRomCurve3, Vector3 } from "three";

export type V3 = [number, number, number];

export const SCREEN = {
  /** The center of the bottom edge of the display. */
  position: [0, 2, -10] as V3,
  width: 26,
  height: 15.6,
};

/** The page drawn on the screen, in units of the page: 0..1 across and down. */
export const PAGE = {
  title: { x: 0.5, y: 0.24 },
  username: { x: 0.33, y: 0.36, w: 0.34, h: 0.075 },
  password: { x: 0.33, y: 0.52, w: 0.34, h: 0.075 },
  button: { x: 0.33, y: 0.66, w: 0.34, h: 0.08 },
  footer: { x: 0.5, y: 0.82 },
};

/** A point of the page, in the world. */
export function onPage(u: number, v: number, out = new Vector3()): Vector3 {
  const [x, y, z] = SCREEN.position;
  return out.set(
    x + (u - 0.5) * SCREEN.width,
    y + (1 - v) * SCREEN.height,
    z + 0.12,
  );
}

export const BUTTON_CENTER = onPage(
  PAGE.button.x + PAGE.button.w / 2,
  PAGE.button.y + PAGE.button.h / 2,
);

export type Thing = {
  id: string;
  label: string;
  /** The center of the footprint on the ground. */
  position: V3;
  size: V3;
};

export const PAGE_CODE: Thing = {
  id: "pageCode",
  label: "Page code",
  position: [-8.5, 0, -2],
  size: [6, 1.8, 3.6],
};
export const AUTH_CLIENT: Thing = {
  id: "authClient",
  label: "Auth client",
  position: [0, 0, 3],
  size: [6, 1.8, 3.6],
};
export const LOCAL_STORAGE: Thing = {
  id: "localStorage",
  label: "localStorage",
  position: [8.5, 0, -2.5],
  size: [6.4, 1.4, 4.2],
};
export const COOKIES: Thing = {
  id: "cookies",
  label: "Cookies",
  position: [-9, 0, 6.5],
  size: [5, 1.2, 3.4],
};
/** The way out of the browser, at its right edge, facing the scene. */
export const EXIT = {
  id: "convex",
  label: "Convex",
  position: [12.5, 0, 9] as V3,
  width: 4,
  height: 4.6,
  /** Turned to face the middle of the scene. */
  rotationY: -Math.PI / 3.4,
};

/** The two token slots of localStorage, as offsets from its center. */
export const SLOTS: { label: string; offset: V3 }[] = [
  { label: "JWT", offset: [-1.5, 0, 0] },
  { label: "Refresh token", offset: [1.5, 0, 0] },
];

const top = (t: Thing, lift = 0.35) =>
  new Vector3(t.position[0], t.size[1] + lift, t.position[2]);

const curve = (...points: Vector3[]) =>
  new CatmullRomCurve3(points, false, "centripetal");

export const AUTH_TOP = top(AUTH_CLIENT);
export const EXIT_POINT = new Vector3(EXIT.position[0], 1.4, EXIT.position[2]);

/** The static routes the scene draws, and the ones the motion follows. */
export const ROUTES = {
  /** From the button on the screen down to the Auth client. */
  press: curve(
    BUTTON_CENTER.clone(),
    new Vector3(0, BUTTON_CENTER.y - 1.2, SCREEN.position[2] + 0.6),
    new Vector3(0, SCREEN.position[1] + 0.3, SCREEN.position[2] + 1.6),
    new Vector3(0, 2.7, -3),
    AUTH_TOP.clone(),
  ),
  /** From the Auth client out through the exit. */
  out: curve(
    AUTH_TOP.clone(),
    new Vector3(3.6, 1.8, 3.6),
    new Vector3(7, 0.9, 7.6),
    EXIT_POINT.clone(),
  ),
  /** From the Auth client into localStorage. */
  store: curve(
    AUTH_TOP.clone(),
    new Vector3(4.2, 3.6, 1.2),
    new Vector3(8.5, 3.4, -2),
    top(LOCAL_STORAGE, 0.4),
  ),
  /** The page code and the Auth client: drawn, not travelled. */
  code: curve(
    top(PAGE_CODE, 0.1),
    new Vector3(-4, 2.6, 0),
    top(AUTH_CLIENT, 0.1),
  ),
  /** The Auth client and the cookies: drawn, not travelled. */
  cookies: curve(
    top(AUTH_CLIENT, 0.1),
    new Vector3(-4, 2.4, 5),
    top(COOKIES, 0.1),
  ),
};
export type RouteName = keyof typeof ROUTES;

/**
 * Whether a point of a route is drawn: the start of the press runs down the
 * face of the screen, where a line would cross the text of the page.
 */
export const drawnPoint = (p: Vector3) => p.y < SCREEN.position[1] + 0.6;

/** Where the camera starts: low, in front, the screen looming above. */
export const START_VIEW = {
  position: [0, 8.5, 31] as V3,
  target: [0, 6, -2] as V3,
};
