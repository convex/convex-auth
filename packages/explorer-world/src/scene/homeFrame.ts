/**
 * Home's camera, fitted to the window: the whole client region on screen,
 * clear of the panels over the canvas, with the world beyond it (toward the
 * platform) in the rest of the window.
 *
 * Pure: it works on a camera it is given and the window's free rectangle,
 * so that any window shape gives the same framing rule.
 */
import { PerspectiveCamera, Vector3 } from "three";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Region {
  center: [number, number, number];
  radius: number;
}

/** The share of the free width (or height, in a tall window) the region takes. */
const SHARE = 0.6;
/** Room left around the region, as a share of its box on screen. */
const MARGIN = 0.06;

/**
 * Where the region goes on the window: in the larger free rectangle beside
 * or above the panel, on the side away from the world beyond it; in a wide
 * one it takes {@link SHARE} of the width, in a tall one of the height.
 */
export function homeRect(
  width: number,
  height: number,
  panel: Rect | null,
  bottomBar: number,
  beyondRight: boolean,
  /** The region's width over its height on screen. */
  aspect = 1.3,
  /** The share of the free room the region takes. */
  share = SHARE,
  /** Where the room starts on the left: right of a column along that side. */
  left = 0,
): Rect {
  const all: Rect = {
    left,
    // Room above the region for its name, which stands over its rim.
    top: Math.min(72, Math.max(36, height * 0.07)),
    right: width,
    bottom: height - bottomBar,
  };
  let free = all;
  if (panel) {
    // Beside the panel, or above it: whichever leaves the region more room.
    const beside: Rect = { ...all, left: panel.right };
    // Above it, with room under the region for a neighbour's name.
    const above: Rect = {
      ...all,
      bottom: Math.min(all.bottom, panel.top - 64),
    };
    // The width the region gets in a rectangle, as `homeRect` shares it.
    const room = (r: Rect) => {
      const w = r.right - r.left;
      const h = r.bottom - r.top;
      return w >= h
        ? Math.min(w * share, h * aspect)
        : Math.min(w, h * share * aspect);
    };
    free = room(beside) >= room(above) ? beside : above;
  }
  const w = free.right - free.left;
  const h = free.bottom - free.top;
  if (w >= h) {
    const across = w * share;
    return beyondRight
      ? { ...free, right: free.left + across }
      : { ...free, left: free.right - across };
  }
  return { ...free, bottom: free.top + h * share };
}

/**
 * The camera position and target that frame `region`, seen from
 * `direction` (from the target toward the camera), inside `rect` of a
 * `width` × `height` window.
 */
export function frameRegion(
  region: Region | Region[],
  direction: Vector3,
  fov: number,
  width: number,
  height: number,
  rect: Rect,
): { position: Vector3; target: Vector3 } {
  const regions = Array.isArray(region) ? region : [region];
  const cam = new PerspectiveCamera(fov, width / height, 0.1, 1e5);
  const dir = direction.clone().normalize();
  const ring = regions.flatMap((r) => ringOf(r));
  const middle = ring
    .reduce((m, p) => m.add(p), new Vector3())
    .divideScalar(ring.length);
  const target = new Vector3(middle.x, 0, middle.z);
  let distance =
    3 *
    Math.max(...ring.map((p) => Math.hypot(p.x - middle.x, p.z - middle.z)));
  // The rectangle in normalized device coordinates.
  const want = {
    x0: (rect.left / width) * 2 - 1,
    x1: (rect.right / width) * 2 - 1,
    y0: 1 - (rect.bottom / height) * 2,
    y1: 1 - (rect.top / height) * 2,
  };
  const right = new Vector3();
  const forward = new Vector3();
  const v = new Vector3();
  for (let i = 0; i < 40; i++) {
    cam.position.copy(target).addScaledVector(dir, distance);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      v.copy(p).project(cam);
      x0 = Math.min(x0, v.x);
      x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y);
      y1 = Math.max(y1, v.y);
    }
    const k = Math.max(
      (x1 - x0) / ((want.x1 - want.x0) * (1 - 2 * MARGIN)),
      (y1 - y0) / ((want.y1 - want.y0) * (1 - 2 * MARGIN)),
    );
    // Move the target so the region's box centres on the rectangle: along
    // the camera's right, and along the ground away from the camera.
    const dx = (want.x0 + want.x1) / 2 - (x0 + x1) / 2;
    const dy = (want.y0 + want.y1) / 2 - (y0 + y1) / 2;
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    forward.copy(dir).negate().setY(0).normalize();
    // One unit of NDC at the target is about this many world units.
    const halfH = distance * Math.tan((fov * Math.PI) / 360);
    target.addScaledVector(right, -dx * halfH * cam.aspect);
    target.addScaledVector(forward, -dy * halfH * 1.4);
    distance *= Math.pow(k, 0.8);
    if (Math.abs(k - 1) < 1e-3 && Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3)
      break;
  }
  return {
    position: target.clone().addScaledVector(dir, distance),
    target,
  };
}

/** Points around a region's rim on the ground. */
function ringOf(region: Region): Vector3[] {
  return Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return new Vector3(
      region.center[0] + region.radius * Math.cos(a),
      0,
      region.center[2] + region.radius * Math.sin(a),
    );
  });
}

/** A region's box on the window, in pixels, from a camera. */
export function regionBox(
  region: Region,
  view: { position: Vector3; target: Vector3 },
  fov: number,
  width: number,
  height: number,
): Rect {
  const cam = new PerspectiveCamera(fov, width / height, 0.1, 1e5);
  cam.position.copy(view.position);
  cam.lookAt(view.target);
  cam.updateMatrixWorld();
  const out = {
    left: Infinity,
    right: -Infinity,
    top: Infinity,
    bottom: -Infinity,
  };
  for (const p of ringOf(region)) {
    p.project(cam);
    const x = ((p.x + 1) / 2) * width;
    const y = ((1 - p.y) / 2) * height;
    out.left = Math.min(out.left, x);
    out.right = Math.max(out.right, x);
    out.top = Math.min(out.top, y);
    out.bottom = Math.max(out.bottom, y);
  }
  return out;
}

/**
 * How large the region must stay, on the window, when Home also shows the
 * island beyond it: this share of its width when Home shows it alone.
 */
const KEEP = 0.6;

/**
 * Home with more in view: the region and `beyond` (the islands a call
 * reaches first) all on the window's free rectangle, when the region
 * then keeps at least {@link KEEP} of the width it has alone; else the
 * region alone, as {@link homeRect} places it.
 */
export function frameHome(
  region: Region,
  beyond: Region[],
  direction: Vector3,
  fov: number,
  width: number,
  height: number,
  panel: Rect | null,
  bottomBar: number,
  beyondRight: boolean,
  aspect: number,
  /** The right edge of a column along the left side (px), if one stands there. */
  left = 0,
): { position: Vector3; target: Vector3 } {
  const rect = homeRect(
    width,
    height,
    panel,
    bottomBar,
    beyondRight,
    aspect,
    SHARE,
    left,
  );
  const alone = frameRegion(region, direction, fov, width, height, rect);
  if (!beyond.length) return alone;
  // The whole free room: a share of 1.
  const room = homeRect(
    width,
    height,
    panel,
    bottomBar,
    beyondRight,
    aspect,
    1,
    left,
  );
  const both = frameRegion(
    [region, ...beyond],
    direction,
    fov,
    width,
    height,
    room,
  );
  const across = (view: typeof both) => {
    const b = regionBox(region, view, fov, width, height);
    return b.right - b.left;
  };
  return across(both) >= KEEP * across(alone) ? both : alone;
}
