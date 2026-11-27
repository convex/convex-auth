/**
 * The gallery of looks (`src/looks/`): the sample motion plays both ways as
 * a pure function of time, and the split holds: the sample scene names no
 * colour and no material, and every look supplies every part.
 */
import { expect, test } from "vitest";
import { DURATION, frameAt } from "../looks/motion.ts";
import { BUTTON_CENTER, LOCAL_STORAGE, ROUTES } from "../looks/layout.ts";

const files = import.meta.glob<string>(["../looks/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

test("the motion starts still at the button and ends with both tokens in localStorage", () => {
  const start = frameAt(0);
  expect(start.pressed).toBe(true);
  expect(start.mover?.position.distanceTo(BUTTON_CENTER)).toBeLessThan(1e-6);
  expect(start.tokens.every((t) => t === null)).toBe(true);
  const end = frameAt(DURATION);
  expect(end.mover).toBeNull();
  expect(end.route).toBeNull();
  for (const t of end.tokens) {
    expect(t?.settled).toBe(true);
    expect(Math.abs(t!.position.x - LOCAL_STORAGE.position[0])).toBeLessThan(
      LOCAL_STORAGE.size[0] / 2,
    );
  }
});

test("scrubbing is smooth: no jump between nearby times, in either direction", () => {
  const step = 1 / 240;
  const where = (t: number) => {
    const f = frameAt(t);
    return [
      f.mover?.position ?? null,
      ...f.tokens.map((x) => x?.position ?? null),
    ];
  };
  let jumps = 0;
  for (let t = 0; t < DURATION; t += step) {
    const a = where(t);
    const b = where(t + step);
    a.forEach((p, i) => {
      const q = b[i];
      if (p && q && p.distanceTo(q) > 0.5) jumps++;
    });
  }
  expect(jumps).toBe(0);
  // The same time gives the same frame, whichever way the handle came.
  expect(frameAt(3.3)).toEqual(frameAt(3.3));
});

test("the motion goes out through the exit and comes back", () => {
  const out = ROUTES.out.getPointAt(1);
  const times = Array.from({ length: 600 }, (_, i) => (i / 600) * DURATION);
  const near = times.filter(
    (t) => (frameAt(t).mover?.position.distanceTo(out) ?? Infinity) < 0.5,
  );
  expect(near.length).toBeGreaterThan(0);
  expect(times.some((t) => frameAt(t).mover?.kind === "response")).toBe(true);
});

test("the sample scene names no colour and no material", () => {
  const scene = files["../looks/SampleScene.tsx"];
  expect(scene).toBeDefined();
  expect(scene).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(scene).not.toMatch(/[Mm]aterial|color|colour|rgb\(/);
});

test("every look supplies every part", () => {
  const parts = [
    "Ground",
    "Screen",
    "Block",
    "Container",
    "Exit",
    "Token",
    "Path",
    "Mover",
    "Label",
  ];
  const kit = files["../looks/look.ts"];
  for (const p of parts) expect(kit).toContain(`${p}: FC`);
  const index = files["../looks/looks/index.ts"];
  const names = [
    ...index.matchAll(/import \{ (\w+) \} from "\.\/(\w+)\.tsx"/g),
  ];
  expect(names.length).toBeGreaterThanOrEqual(6);
  for (const [, , file] of names) {
    const source = files[`../looks/looks/${file}.tsx`];
    // A look either takes the standard parts from a style or spells them out.
    expect(source).toMatch(/makeParts\(|parts: \{/);
    expect(source).toMatch(/Stage:/);
    expect(source).toMatch(/Effects:/);
    // Bloom or any composer reads half floats: the sanitize pass goes first.
    if (/EffectComposer/.test(source))
      expect(source).toMatch(
        /<EffectComposer[^>]*>\s*<primitive object=\{pass\} \/>/,
      );
  }
});
