import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

const events = parseNdjson(
  readFileSync(
    new URL("./fixtures/live-actions.ndjson", import.meta.url),
    "utf8",
  ),
);
const { world } = worldFromEvents(
  prepareProject(PROJECTS["convex-auth"]),
  events,
  "live",
);

test("the client district has a heart: what the rest imports is larger and nearer the middle", () => {
  const district = world.layout.islands.find(
    (i) => i.id === "library:region:browser",
  )!;
  const at = (id: string) => {
    const p = world.layout.parts.get(id)!;
    return {
      r: p.radius,
      d: Math.hypot(
        p.position[0] - district.position[0],
        p.position[2] - district.position[2],
      ),
    };
  };
  const heart = [
    "module:browser/sessionManager",
    "module:browser/storage",
    "module:browser/mutex",
  ].map(at);
  const parts = district.members.map(at);
  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[xs.length >> 1];
  for (const h of heart) {
    expect(h.r).toBeGreaterThan(median(parts.map((p) => p.r)) * 1.3);
    expect(h.d).toBeLessThan(median(parts.map((p) => p.d)));
  }
  // Every part is present from the start.
  expect(district.members.length).toBeGreaterThan(60);
});
