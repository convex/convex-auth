/**
 * The gallery of looks (`src/looks/`): the sample motion plays both ways as
 * a pure function of time, and the split holds: the sample scene names no
 * colour and no material, and every look supplies every part.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as vast from "../looks/vast/motion.ts";
import {
  APP_CODE,
  AUTH_CLIENT,
  JWT_KEY,
  REFRESH_KEY,
} from "../looks/vast/world.ts";
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
  const scenes = [
    "../looks/SampleScene.tsx",
    "../looks/vast/VastScene.tsx",
    "../looks/vast/world.ts",
    "../looks/vast/motion.ts",
    "../looks/vast/reveal.tsx",
    "../looks/vast/views.ts",
  ];
  for (const name of scenes) {
    const scene = files[name];
    expect(scene, name).toBeDefined();
    expect(scene, name).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(scene, name).not.toMatch(/[Mm]aterial|color|colour|rgb\(/);
  }
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
    expect(source).toMatch(/makeParts\(|parts: \{|world: \{/);
    if (/world: \{/.test(source))
      for (const p of [
        "Ground",
        "Monument",
        "Place",
        "Piece",
        "Gate",
        "Trail",
        "Carrier",
        "Name",
      ])
        expect(source).toMatch(new RegExp(`world: \\{[^}]*\\b${p}\\b`));
    expect(source).toMatch(/Stage:/);
    expect(source).toMatch(/Effects:/);
    // Bloom or any composer reads half floats: the sanitize pass goes first.
    if (/EffectComposer/.test(source))
      expect(source).toMatch(
        /<EffectComposer[^>]*>\s*<primitive object=\{pass\} \/>/,
      );
  }
});

test("the vast sample's motion starts still at the button and ends with both keys set", () => {
  const start = vast.frameAt(0);
  expect(start.pressed).toBe(true);
  expect(start.keys[JWT_KEY.id]).toBe(0);
  const end = vast.frameAt(vast.DURATION);
  expect(end.carrier).toBeNull();
  expect(end.tokens.every((t) => t === null)).toBe(true);
  expect(end.keys[JWT_KEY.id]).toBe(1);
  expect(end.keys[REFRESH_KEY.id]).toBe(1);
  expect(end.active).toBeNull();
  // It reaches the backend's gate on the way.
  const times = Array.from(
    { length: 2000 },
    (_, i) => (i / 2000) * vast.DURATION,
  );
  expect(times.some((t) => vast.frameAt(t).active === "convexBackend")).toBe(
    true,
  );
});

test("the vast sample scrubs smoothly in either direction", () => {
  const step = 1 / 240;
  const where = (t: number) => {
    const f = vast.frameAt(t);
    return [
      f.carrier?.position ?? null,
      ...f.tokens.map((x) => x?.position ?? null),
    ];
  };
  let jumps = 0;
  for (let t = 0; t < vast.DURATION; t += step) {
    const a = where(t);
    const b = where(t + step);
    // The long way to the backend is the fastest leg: about 4 m a step.
    a.forEach((p, i) => {
      const q = b[i];
      if (p && q && p.distanceTo(q) > 8) jumps++;
    });
  }
  expect(jumps).toBe(0);
  expect(vast.frameAt(6.7)).toEqual(vast.frameAt(6.7));
});

test("the vast sample names real files and functions", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const dirs = new Map([
    [APP_CODE, "examples/react-username-password/src/"],
    [AUTH_CLIENT, "packages/core/src/"],
  ]);
  for (const [district, dir] of dirs)
    for (const m of district.children) {
      const path = root + dir + m.label;
      expect(existsSync(path), path).toBe(true);
      const source = readFileSync(path, "utf8");
      for (const f of m.children)
        expect(source, `${f.label} in ${m.label}`).toContain(
          f.label.split(".").pop(),
        );
    }
});
