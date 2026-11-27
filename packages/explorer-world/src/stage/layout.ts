/**
 * Where the things of the stage stand. One unit is about a metre. The screen
 * stands at the back on the ground (y = 0 is the top of the browser's floor;
 * the ground is lower). The browser's floor lies in front of the screen and
 * below it, between the screen and the viewer; nothing stands behind the
 * screen. The exits stand on the ground at the front edge; the space further
 * forward and lower is left for the servers.
 *
 * @module
 */

export type Vec3 = [number, number, number];

/** The app's page, in CSS pixels, and the screen that shows it. */
export const SCREEN = {
  pxWidth: 1280,
  pxHeight: 800,
  width: 16,
  height: 10,
  center: [0, 8.4, -15.5] as Vec3,
  bezel: 0.35,
};

/** The top of the ground, below the floor of the browser. */
export const GROUND_Y = -0.8;

export const PLATFORM = { x: [-11.5, 11.5], z: [-12.8, 7.5] } as const;

/** A box on the floor: its centre on the floor (x, z), size and height. */
export type Spot = { x: number; z: number; w: number; d: number; h: number };

export const PAGE: Spot = { x: 0, z: -10.4, w: 18, d: 2.6, h: 0.45 };

/** The client code, left to right. */
export const CLIENT: Spot[] = [
  { x: -6.8, z: -5.2, w: 5.2, d: 2.4, h: 1.3 },
  { x: 0, z: -5.2, w: 5.2, d: 2.4, h: 1.3 },
  { x: 6.8, z: -5.2, w: 5.2, d: 2.4, h: 1.3 },
];

export const LOCAL: Spot = { x: -6.6, z: 0.4, w: 8.6, d: 3.6, h: 0.35 };
export const COOKIES: Spot = { x: -6.6, z: 5, w: 8.6, d: 2.6, h: 0.35 };

/** The connections out: a pipe on the floor from the client to the edge. */
export const PIPES = {
  http: { x: 1.4, from: -3.4, to: PLATFORM.z[1] },
  socket: { x: 6.8, from: -3.4, to: PLATFORM.z[1] },
};

/** The exits, on the ground past the front edge. */
export const EXIT_Z = 9.6;
export const EXITS: Record<string, { x: number; w: number }> = {
  page: { x: -4.6, w: 6.2 },
  backend: { x: 5.2, w: 7.6 },
};
/** Exits seen in a recording (other sites) stand further right. */
export const extraExit = (i: number) => ({ x: 14 + i * 5.5, w: 4.6 });

/** The heights where things in flight travel. */
export const FLIGHT_Y = 0.55;

/** The camera's places. */
export const DEFAULT_VIEW = {
  position: [0, 17, 30] as Vec3,
  target: [0, 2.4, -3.5] as Vec3,
};
