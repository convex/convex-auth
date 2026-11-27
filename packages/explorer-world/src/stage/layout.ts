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

/**
 * The ground plan below is drawn at this scale; heights are kept. At 1 the
 * territory is as wide as the screen (480 m against a 512 m wall), and from
 * afar the two read as one compact object on the plane. Which proportion to
 * keep is not settled: this is the one knob for it.
 */
export const GROUND = 1;
/** The back edge of the territory, which the scale keeps in place. */
const BACK = -300;
const gx = (x: number) => x * GROUND;
const gz = (z: number) => BACK + (z - BACK) * GROUND;
/** A spot of the plan, at the ground's scale (heights are kept). */
const ground = (s: Spot): Spot => ({
  x: gx(s.x),
  z: gz(s.z),
  w: s.w * GROUND,
  d: s.d * GROUND,
  h: s.h,
});

/** The browser's territory on the ground. */
export const TERRITORY = {
  x: [gx(-240), gx(240)],
  z: [gz(-300), gz(48)],
} as const;

/** A district or a thing on the ground: centre (x, z), size and height. */
export type Spot = { x: number; z: number; w: number; d: number; h: number };

export const PAGE: Spot = ground({ x: 0, z: -262, w: 200, d: 38, h: 3 });

/** The client code, left to right. */
export const CLIENT: Spot[] = [
  { x: -158, z: -188, w: 110, d: 60, h: 7 },
  { x: 0, z: -188, w: 140, d: 60, h: 7 },
  { x: 158, z: -188, w: 110, d: 60, h: 7 },
].map(ground);

export const LOCAL: Spot = ground({ x: -150, z: -92, w: 140, d: 70, h: 4 });
export const COOKIES: Spot = ground({ x: -150, z: -8, w: 140, d: 50, h: 4 });

/** The connections out: a channel from the client code to the exits. */
export const CHANNELS = {
  http: { x: gx(40), from: gz(-152), to: gz(44), width: 12 * GROUND },
  socket: { x: gx(158), from: gz(-152), to: gz(44), width: 12 * GROUND },
};

/** The exits, at the front edge of the territory. */
export const EXIT_Z = gz(60);
export const EXITS: Record<string, { x: number; w: number }> = {
  page: { x: gx(-40), w: 60 * GROUND },
  backend: { x: gx(130), w: 100 * GROUND },
};
/** Exits seen in a recording (other sites) stand further right. */
export const extraExit = (i: number) => ({
  x: gx(260 + i * 56),
  w: 46 * GROUND,
});
export const EXIT_HEIGHT = 12;

/** The height where things in flight travel, and their size. */
export const FLIGHT = { y: 3.5, size: 4, httpSize: 5.5 };

/**
 * The camera's places. Low over the ground: the browser in front, the
 * screen filling the upper background.
 */
export const DEFAULT_VIEW = {
  position: [0, 150, gz(-220) + 520] as Vec3,
  target: [0, 58, gz(-220)] as Vec3,
};

/** How far the camera may go: from a metre to a few kilometres. */
export const ZOOM = { min: 1, max: 6000 };

/**
 * A container shows its insides when the camera is within this many times
 * its size, and its own label from within `LABEL_FAR` times.
 */
export const REVEAL = 3.2;
export const LABEL_FAR = 14;

/**
 * Labels are drawn at reading size: this share of their distance to the
 * camera (about 15 px on a window 900 px high), never larger than their
 * own size, and only while reading size is within `LABEL_FIT` times that.
 */
export const LABEL_READ = 0.017;
export const LABEL_FIT = 1.6;

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

/** Lays `n` things out in a grid inside a spot, with a margin. */
export function grid(
  spot: Spot,
  n: number,
  { margin = 0.12, front = 0.22, aspect = 2.2 } = {},
) {
  const w = spot.w * (1 - margin * 2);
  const d = spot.d * (1 - margin - front);
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * w) / (d * aspect))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = w / cols;
  const rd = d / rows;
  return {
    cw,
    rd,
    at: (i: number) => ({
      x: spot.x - w / 2 + ((i % cols) + 0.5) * cw,
      z:
        spot.z -
        spot.d / 2 +
        spot.d * margin +
        (Math.floor(i / cols) + 0.5) * rd,
    }),
  };
}
