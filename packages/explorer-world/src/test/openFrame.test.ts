/**
 * The camera of a part opened up (`scene/openFrame.ts`): the disc whole in
 * the free rectangle, clear of the panels, from the direction asked.
 */
import { PerspectiveCamera, Vector3 } from "three";
import { expect, test } from "vitest";
import { frameOpen, openDirection } from "../scene/openFrame.ts";

const W = 1440;
const H = 810;
// Right of the column and a card beside it; above the controls row.
const rect = { left: 650, top: 12, right: 1428, bottom: 735 };

/** Where a point is on the window (px), seen from a frame. */
function onWindow(frame: ReturnType<typeof frameOpen>, p: Vector3) {
  const cam = new PerspectiveCamera(42, W / H, 0.1, 1000);
  cam.position.copy(frame.position);
  cam.lookAt(frame.target);
  cam.updateMatrixWorld();
  const v = p.clone().project(cam);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

const centre = new Vector3(-160, 3, 8);
const radius = 3.2;

test("the disc's rim stands whole in the free rectangle, its centre in the middle", () => {
  for (const heading of [new Vector3(0, 0, 1), new Vector3(-1, 0, 0.3)]) {
    const frame = frameOpen(
      centre,
      radius,
      openDirection(heading),
      42,
      W,
      H,
      rect,
    );
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 16) {
      const rim = centre
        .clone()
        .add(new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      const p = onWindow(frame, rim);
      expect(p.x).toBeGreaterThanOrEqual(rect.left);
      expect(p.x).toBeLessThanOrEqual(rect.right);
      expect(p.y).toBeGreaterThanOrEqual(rect.top);
      expect(p.y).toBeLessThanOrEqual(rect.bottom);
    }
    const c = onWindow(frame, centre);
    expect(c.x).toBeCloseTo((rect.left + rect.right) / 2, -1);
    expect(c.y).toBeCloseTo((rect.top + rect.bottom) / 2, -1);
  }
});

test("from the same direction, a member stands in the same place every time", () => {
  const member = centre.clone().add(new Vector3(1.2, 0, -0.7));
  const from = openDirection(new Vector3(0, 0, 1));
  const a = onWindow(frameOpen(centre, radius, from, 42, W, H, rect), member);
  const b = onWindow(frameOpen(centre, radius, from, 42, W, H, rect), member);
  expect(a).toEqual(b);
  // Looked at from another side, it is elsewhere.
  const side = openDirection(new Vector3(1, 0, 0));
  const c = onWindow(frameOpen(centre, radius, side, 42, W, H, rect), member);
  expect(Math.hypot(c.x - a.x, c.y - a.y)).toBeGreaterThan(20);
});
