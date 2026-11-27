import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { expect, test } from "vitest";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";
import { frameHome, regionBox } from "../scene/homeFrame.ts";

const events = parseNdjson(
  readFileSync(
    new URL("./fixtures/live-actions.ndjson", import.meta.url),
    "utf8",
  ),
);
const project = prepareProject(PROJECTS["convex-auth"]);
const { world } = worldFromEvents(project, events, "live");
const app = `app:${world.recording.app}`;
const at = (id: string) => world.layout.parts.get(id)!;
const browser = at("region:browser");
const gap = (id: string) =>
  Math.hypot(
    at(id).position[0] - browser.position[0],
    at(id).position[2] - browser.position[2],
  ) - at(id).radius;
/** The components the running app mounts, from the structure. */
const mounted = world.graph.links
  .filter((l) => l.kind === "mounts" && l.from === app)
  .map((l) => l.to);

test("the world is laid out around the app the recording names", () => {
  expect(world.recording.app).toBe("react-username-password");
  expect(world.presentation.focus).toBe(app);
});

test("the running app faces the browser, what it mounts beside it, the rest beyond", () => {
  /** The platform's own islands and the apps on region:app. */
  const platform = world.layout.islands.filter(
    (i) =>
      (i.zone === "platform" && i.depth === 0) ||
      i.parentIsland === "region:app",
  );
  const nearest = [...platform].sort((a, b) => gap(a.id) - gap(b.id));
  // Nothing on the platform but what the app uses is nearer the browser.
  const near = new Set([app, ...mounted]);
  const firstOther = nearest.findIndex(
    (i) =>
      !near.has(i.id) && !i.id.startsWith("method:") && i.id !== "region:app",
  );
  for (const id of near)
    expect(nearest.findIndex((i) => i.id === id)).toBeLessThan(firstOther);
  // The app stands nearer the browser than any other app.
  const apps = platform.filter((i) => i.id.startsWith("app:"));
  expect(Math.min(...apps.map((i) => gap(i.id)))).toBe(gap(app));
  expect(mounted.length).toBeGreaterThan(1);
});

test("a recording in another app is laid out around that app", () => {
  const other = events.map((e) =>
    e.kind === "recording" ? { ...e, app: "react-github" } : e,
  );
  const { world: w } = worldFromEvents(project, other, "other");
  const g = (id: string) => {
    const p = w.layout.parts.get(id)!;
    const b = w.layout.parts.get("region:browser")!;
    return (
      Math.hypot(p.position[0] - b.position[0], p.position[2] - b.position[2]) -
      p.radius
    );
  };
  expect(w.presentation.focus).toBe("app:react-github");
  expect(g("app:react-github")).toBeLessThan(g("app:react-username-password"));
  expect(g("component:authGithub")).toBeLessThan(g("component:authPassword"));
});

test("with no events the presentation's focus is the default", () => {
  const { world: w } = worldFromEvents(project, [], "none");
  expect(w.presentation.focus).toBe("app:react-username-password");
});

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
  [2560, 900],
  [900, 1000],
  [390, 844],
])
  test(`Home on a ${width}×${height} window has the browser and the running app, the browser the larger`, () => {
    const home = world.layout.home!;
    expect(home.beyond[0].center).toEqual(at(app).position);
    const held = new Set(
      home.beyond.map(
        (r) =>
          [...world.layout.parts.values()].find((q) => q.position === r.center)!
            .id,
      ),
    );
    for (const id of mounted) expect(held).toContain(id);
    const fov = 42;
    const direction = new Vector3(...home.position)
      .sub(new Vector3(...home.target))
      .normalize();
    const view = frameHome(
      home.region,
      home.beyond,
      direction,
      fov,
      width,
      height,
      { left: 0, right: width, top: height - 90, bottom: height - 50 },
      44,
      true,
      1 / direction.y,
    );
    const b = regionBox(home.region, view, fov, width, height);
    const a = regionBox(home.beyond[0], view, fov, width, height);
    const used = home.beyond.map((r) => regionBox(r, view, fov, width, height));
    for (const box of [b, ...used]) {
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(width + 1);
      expect(box.top).toBeGreaterThanOrEqual(-1);
      expect(box.bottom).toBeLessThanOrEqual(height + 1);
    }
    // The browser keeps most of the room the two take.
    expect(b.right - b.left).toBeGreaterThan(1.5 * (a.right - a.left));
    // It is not a speck: it fills much of the window one way.
    expect(
      Math.max((b.right - b.left) / width, (b.bottom - b.top) / height),
    ).toBeGreaterThan(0.45);
  });
