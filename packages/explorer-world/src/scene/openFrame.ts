/**
 * The camera of a part opened up: its disc whole in the free rectangle of
 * the window, clear of the panels over the canvas (the left column, the
 * controls row and the time line), looked at from a given direction.
 *
 * Pure: it works on numbers it is given, so any window gives the same rule.
 */
import { Vector3 } from "three";
import type { Rect } from "./homeFrame.ts";

/** Room left around the disc and the names on it, as a share of its radius. */
const ROOM = 0.18;

export interface OpenFrame {
  position: Vector3;
  target: Vector3;
}

/**
 * Where the camera stands to show a disc of `radius` at `centre` from the
 * direction `from` (a unit vector from the disc toward the camera), with the
 * disc in `rect` (px) of a `width` × `height` window seen with `fov`
 * (vertical, degrees). The disc lies flat: seen from above at an angle, it
 * takes less height than width.
 */
export function frameOpen(
  centre: Vector3,
  radius: number,
  from: Vector3,
  fov: number,
  width: number,
  height: number,
  rect: Rect,
  /** No farther than this: a part opens up only with the camera near. */
  maxDistance = Infinity,
): OpenFrame {
  const r = radius * (1 + ROOM);
  const tall = r * Math.max(0.5, Math.abs(from.y));
  const halfW = Math.max(40, (rect.right - rect.left) / 2);
  const halfH = Math.max(40, (rect.bottom - rect.top) / 2);
  const tan = Math.tan(((fov / 2) * Math.PI) / 180);
  // World units per pixel at distance d: 2 d tan / height.
  const distance = Math.min(
    maxDistance,
    (Math.max(r / halfW, tall / halfH) * (height / 2)) / tan,
  );
  const perPx = (2 * distance * tan) / height;
  const forward = from.clone().negate();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  // The disc's centre goes to the rectangle's centre, not the window's.
  const cx = (rect.left + rect.right) / 2 - width / 2;
  const cy = height / 2 - (rect.top + rect.bottom) / 2;
  const target = centre
    .clone()
    .addScaledVector(right, -cx * perPx)
    .addScaledVector(up, -cy * perPx);
  return {
    position: target.clone().addScaledVector(from, distance),
    target,
  };
}

/** The direction an opened part is seen from: as far out as it is up (Inside's). */
export const OPEN_ELEVATION = { out: 5.2, up: 6.4 };

/** The direction from a horizontal heading, at the opened-up elevation. */
export function openDirection(heading: Vector3): Vector3 {
  const h = new Vector3(heading.x, 0, heading.z);
  if (h.lengthSq() < 1e-9) h.set(0, 0, 1);
  h.normalize().multiplyScalar(OPEN_ELEVATION.out);
  return h.setY(OPEN_ELEVATION.up).normalize();
}
