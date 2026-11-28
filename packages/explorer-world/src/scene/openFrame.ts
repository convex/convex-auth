/**
 * The camera of a part opened up: its disc whole in the free rectangle of
 * the window, clear of the panels over the canvas (the left column, the
 * controls row and the time line), looked at from a given direction.
 *
 * Pure: it works on numbers it is given, so any window gives the same rule.
 */
import { Vector3 } from "three";
import type { Rect } from "./homeFrame.ts";

/** Room left around what is fitted, as a share of the rectangle (each side). */
const ROOM = 0.04;

export interface OpenFrame {
  position: Vector3;
  target: Vector3;
}

/** A name on the disc: where it stands, half its width, and how high it rises (m). */
export interface FitName {
  at: Vector3;
  halfWidth: number;
  rise: number;
}

/**
 * Where the camera stands to show a disc of `radius` at `centre`, and the
 * names on and around it (`names`), from the direction `from` (a unit
 * vector from the disc toward the camera): all of it in `rect` (px) of a
 * `width` × `height` window seen with `fov` (vertical, degrees), its middle
 * in the middle of `rect`.
 */
export function frameOpen(
  centre: Vector3,
  radius: number,
  from: Vector3,
  fov: number,
  width: number,
  height: number,
  rect: Rect,
  names: FitName[] = [],
): OpenFrame {
  const forward = from.clone().negate();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  // What must be on the window: the rim, and each name's ends and top.
  const points: Vector3[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    points.push(
      centre
        .clone()
        .add(new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius)),
    );
  }
  for (const n of names)
    for (const side of [-1, 1])
      for (const rise of [0, n.rise])
        points.push(
          n.at
            .clone()
            .addScaledVector(right, side * n.halfWidth)
            .setY(n.at.y + rise),
        );
  const tan = Math.tan(((fov / 2) * Math.PI) / 180);
  const room = {
    left: rect.left + (rect.right - rect.left) * ROOM,
    right: rect.right - (rect.right - rect.left) * ROOM,
    top: rect.top + (rect.bottom - rect.top) * ROOM,
    bottom: rect.bottom - (rect.bottom - rect.top) * ROOM,
  };
  const halfW = Math.max(40, (room.right - room.left) / 2);
  const halfH = Math.max(40, (room.bottom - room.top) / 2);
  const midX = (room.left + room.right) / 2;
  const midY = (room.top + room.bottom) / 2;
  // A first guess from the radius, then a few rounds of looking through
  // the camera: as far as needed for the box of it all to fit, its middle
  // moved to the middle of the room.
  let distance = ((radius / Math.min(halfW, halfH)) * (height / 2)) / tan;
  let target = centre.clone();
  const v = new Vector3();
  for (let round = 0; round < 6; round++) {
    const eye = target.clone().addScaledVector(from, distance);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const p of points) {
      v.copy(p).sub(eye);
      const depth = v.dot(forward);
      const px = (v.dot(right) / (depth * tan)) * (height / 2) + width / 2;
      const py = height / 2 - (v.dot(up) / (depth * tan)) * (height / 2);
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
    const scale = Math.max((x1 - x0) / 2 / halfW, (y1 - y0) / 2 / halfH);
    // Move what is seen so the box's middle comes to the room's middle,
    // at the scale of the depth of the centre.
    const perPx = (2 * distance * tan) / height;
    target = target
      .addScaledVector(right, ((x0 + x1) / 2 - midX) * perPx)
      .addScaledVector(up, -((y0 + y1) / 2 - midY) * perPx);
    distance *= scale;
  }
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
