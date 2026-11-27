/**
 * Where the things of the stage stand. One unit is about a metre; the
 * ground is y = 0 and stretches far in every direction.
 *
 * The screen is a monument: a free-standing wall at the back, the size of a
 * building, with the app's page on it. Everything else is in front of it and
 * below it. The browser is a large territory on the ground between the
 * screen and the viewer; inside it each part of the browser has its own
 * district, a large low building with room around it, and each district
 * holds smaller things that show as you come near. At the territory's front
 * edge stand the exits; the ground beyond them, further forward, is kept for
 * the servers and the sign-in providers, which are not built yet.
 *
 * Each district is placed on its own; adding one, or a level inside one,
 * moves nothing else.
 *
 * @module
 */

export type Vec3 = [number, number, number];

/** The app's page, in CSS pixels, and the wall that shows it. */
export const SCREEN = {
  /**
   * The page is laid out at this width and scaled up, as a display shows
   * it, so that its text can be read from afar.
   */
  pxWidth: 800,
  pxHeight: 500,
  width: 480,
  height: 300,
  /** The centre of the page on the wall. */
  center: [0, 172, -390] as Vec3,
  /** The wall around it, reaching the ground. */
  wall: { width: 512, top: 340, depth: 14 },
};

/** The browser's territory on the ground. */
export const TERRITORY = { x: [-240, 240], z: [-300, 48] } as const;

/** A district or a thing on the ground: centre (x, z), size and height. */
export type Spot = { x: number; z: number; w: number; d: number; h: number };

export const PAGE: Spot = { x: 0, z: -262, w: 200, d: 38, h: 3 };

/** The client code, left to right. */
export const CLIENT: Spot[] = [
  { x: -158, z: -188, w: 110, d: 60, h: 7 },
  { x: 0, z: -188, w: 140, d: 60, h: 7 },
  { x: 158, z: -188, w: 110, d: 60, h: 7 },
];

export const LOCAL: Spot = { x: -150, z: -92, w: 140, d: 70, h: 4 };
export const COOKIES: Spot = { x: -150, z: -8, w: 140, d: 50, h: 4 };

/** The connections out: a channel from the client code to the exits. */
export const CHANNELS = {
  http: { x: 40, from: -152, to: 44, width: 12 },
  socket: { x: 158, from: -152, to: 44, width: 12 },
};

/** The exits, at the front edge of the territory. */
export const EXIT_Z = 60;
export const EXITS: Record<string, { x: number; w: number }> = {
  page: { x: -40, w: 60 },
  backend: { x: 130, w: 100 },
};
/** Exits seen in a recording (other sites) stand further right. */
export const extraExit = (i: number) => ({ x: 260 + i * 56, w: 46 });
export const EXIT_HEIGHT = 12;

/** The height where things in flight travel, and their size. */
export const FLIGHT = { y: 3.5, size: 4, httpSize: 5.5 };

/**
 * The camera's places. Low over the ground: the browser in front, the
 * screen filling the upper background.
 */
export const DEFAULT_VIEW = {
  position: [0, 150, 300] as Vec3,
  target: [0, 58, -220] as Vec3,
};

/** How far the camera may go: from a metre to a few kilometres. */
export const ZOOM = { min: 1, max: 6000 };

/**
 * A container shows its insides when the camera is within this many times
 * its size, and its own label from within `LABEL_FAR` times.
 */
export const REVEAL = 3.2;
export const LABEL_FAR = 14;

/** The camera's field of view, in degrees, top to bottom. */
export const FOV = 55;

/** How far the world reaches: the point looked at stays inside it. */
export const WORLD = { extent: 6000, height: 1200 };

/** What the default view keeps in the window, whatever its shape. */
export const HOME_FIT: Vec3[] = [
  [-SCREEN.wall.width / 2, SCREEN.wall.top, SCREEN.center[2]],
  [SCREEN.wall.width / 2, SCREEN.wall.top, SCREEN.center[2]],
  [TERRITORY.x[0], 0, TERRITORY.z[1]],
  [TERRITORY.x[1], 0, TERRITORY.z[1]],
  [EXITS.page.x - EXITS.page.w / 2, 0, EXIT_Z],
  [EXITS.backend.x + EXITS.backend.w / 2, 0, EXIT_Z],
];
