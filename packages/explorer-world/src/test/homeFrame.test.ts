import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, test } from "vitest";
import { frameRegion, homeRect, type Rect } from "../scene/homeFrame.ts";

const region = {
  center: [-120, 0, 10] as [number, number, number],
  radius: 40,
};
const direction = new Vector3(0, 0.78, 0.63).normalize();
const FOV = 42;

/** The region's box on screen, in pixels, from the camera `frameRegion` gives. */
function box(width: number, height: number, rect: Rect) {
  const { position, target } = frameRegion(
    region,
    direction,
    FOV,
    width,
    height,
    rect,
  );
  const cam = new PerspectiveCamera(FOV, width / height, 0.1, 1e5);
  cam.position.copy(position);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const out = {
    left: Infinity,
    right: -Infinity,
    top: Infinity,
    bottom: -Infinity,
  };
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const v = new Vector3(
      region.center[0] + region.radius * Math.cos(a),
      0,
      region.center[2] + region.radius * Math.sin(a),
    ).project(cam);
    const x = ((v.x + 1) / 2) * width;
    const y = ((1 - v.y) / 2) * height;
    out.left = Math.min(out.left, x);
    out.right = Math.max(out.right, x);
    out.top = Math.min(out.top, y);
    out.bottom = Math.max(out.bottom, y);
  }
  return out;
}

describe("Home's framing", () => {
  const panel = (h: number): Rect => ({
    left: 18,
    right: 318,
    top: h - 252,
    bottom: h - 52,
  });
  for (const [w, h] of [
    [1280, 800],
    [1920, 1080],
    [900, 1000],
    [390, 844],
    [2560, 900],
  ])
    test(`the whole region is on a ${w}×${h} window, clear of the panel, and fills much of its room`, () => {
      const rect = homeRect(w, h, panel(h), 44, true, 1 / direction.y);
      const b = box(w, h, rect);
      expect(b.left).toBeGreaterThanOrEqual(rect.left - 1);
      expect(b.right).toBeLessThanOrEqual(rect.right + 1);
      expect(b.top).toBeGreaterThanOrEqual(rect.top - 1);
      expect(b.bottom).toBeLessThanOrEqual(rect.bottom + 1);
      const p = panel(h);
      const overlaps =
        b.left < p.right &&
        b.right > p.left &&
        b.top < p.bottom &&
        b.bottom > p.top;
      expect(overlaps).toBe(false);
      // It is not a speck: one side fills most of its rectangle.
      const fill = Math.max(
        (b.right - b.left) / (rect.right - rect.left),
        (b.bottom - b.top) / (rect.bottom - rect.top),
      );
      expect(fill).toBeGreaterThan(0.8);
      // Room is left for the world beyond, to the right.
      if (w > h) expect(b.right).toBeLessThan(w * 0.8);
    });
});
