/** A layout is a strategy: one function from the graph to placements. */
import { expect, test } from "vitest";
import { LAYOUTS } from "../layout/index.ts";
import { packCircles } from "../layout/islands.ts";
import type { LayoutStrategy, Placement } from "../layout/types.ts";
import { createWorld } from "../model/world.ts";
import { loadProject, PROJECTS } from "../project.ts";

test("another strategy replaces the islands with no other change", () => {
  // Stacked layers: one row per kind of part, nothing else.
  const layers: LayoutStrategy = (graph) => {
    const kinds = [...new Set(graph.parts.map((p) => p.kind))];
    const parts = new Map<string, Placement>();
    for (const p of graph.parts) {
      const row = graph.parts.filter((q) => q.kind === p.kind);
      parts.set(p.id, {
        id: p.id,
        shape: "marker",
        position: [row.indexOf(p) * 3, kinds.indexOf(p.kind) * 6, 0],
        radius: 1,
        island: null,
        color: "#ffffff",
      });
    }
    return {
      strategy: "layers",
      parts,
      islands: [],
      platform: { center: [0, 0, 0], radius: 10 },
      overview: { position: [0, 40, 80], target: [0, 0, 0] },
      unplaced: [],
    };
  };
  LAYOUTS.layers = layers;
  const base = loadProject(PROJECTS.chat);
  const world = createWorld(base.graph, base.recording, {
    ...base.presentation,
    layout: "layers",
  });
  expect(world.layout.strategy).toBe("layers");
  expect(world.layout.parts.size).toBe(base.graph.parts.length);
  expect(world.timeline.chapters).toHaveLength(base.timeline.chapters.length);
  delete LAYOUTS.layers;
});

test("packed circles do not overlap", () => {
  const radii = [3, 1, 1, 2, 0.5, 0.5, 4, 1, 1, 1, 2.5];
  const circles = packCircles(radii, 0.5);
  for (let i = 0; i < circles.length; i++)
    for (let j = i + 1; j < circles.length; j++)
      expect(
        Math.hypot(circles[i].x - circles[j].x, circles[i].z - circles[j].z),
      ).toBeGreaterThanOrEqual(circles[i].r + circles[j].r + 0.5 - 1e-9);
});
