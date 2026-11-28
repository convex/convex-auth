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

test("the rim and the names stand whole in the free rectangle, in its middle", () => {
  // A long name hanging out past the rim, on the right.
  const names = [
    {
      at: centre.clone().add(new Vector3(radius - 0.2, 0.3, 1.3)),
      halfWidth: 1.2,
      rise: 0.2,
    },
  ];
  for (const heading of [new Vector3(0, 0, 1), new Vector3(-1, 0, 0.3)]) {
    const from = openDirection(heading);
    const frame = frameOpen(centre, radius, from, 42, W, H, rect, names);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 16) {
      const rim = centre
        .clone()
        .add(new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      const p = onWindow(frame, rim);
      xs.push(p.x);
      ys.push(p.y);
    }
    // The name's ends, along the window's horizontal.
    const right = new Vector3()
      .crossVectors(from.clone().negate(), new Vector3(0, 1, 0))
      .normalize();
    for (const side of [-1, 1]) {
      const p = onWindow(
        frame,
        names[0].at.clone().addScaledVector(right, side * 1.2),
      );
      xs.push(p.x);
      ys.push(p.y);
    }
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(rect.left);
    expect(Math.max(...xs)).toBeLessThanOrEqual(rect.right);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(rect.top);
    expect(Math.max(...ys)).toBeLessThanOrEqual(rect.bottom);
    // It fills the room, not a corner of it.
    const mid = (v: number[]) => (Math.min(...v) + Math.max(...v)) / 2;
    expect(Math.abs(mid(xs) - (rect.left + rect.right) / 2)).toBeLessThan(15);
    expect(Math.abs(mid(ys) - (rect.top + rect.bottom) / 2)).toBeLessThan(15);
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
