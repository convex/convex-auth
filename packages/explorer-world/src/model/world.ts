import { LAYOUTS, type Layout } from "../layout/index.ts";
import type { Presentation } from "../presentation.ts";
import { indexGraph, type Graph, type GraphIndex } from "./graph.ts";
import { stateAt, type WorldState } from "./playback.ts";
import type { Recording } from "./recording.ts";
import { buildTimeline, type Timeline } from "./schedule.ts";

/** Everything the scene and the UI read: the graph, its layout, and the recording on a timeline. */
export interface World {
  presentation: Presentation;
  graph: Graph;
  index: GraphIndex;
  layout: Layout;
  recording: Recording;
  timeline: Timeline;
  /** The state field of each table that has one. */
  stateFields: Map<string, string>;
  stateAt: (t: number) => WorldState;
}

/**
 * `layout` reuses the layout of an earlier world of the same graph, so that a
 * world rebuilt as a live recording grows does not lay the map out again.
 */
export function createWorld(
  graph: Graph,
  recording: Recording,
  presentation: Presentation,
  layout?: Layout,
): World {
  const index = indexGraph(graph);
  layout ??= layOut(graph, presentation);
  const timeline = buildTimeline(index, recording, presentation.brackets);
  const stateFields = new Map(
    Object.entries(presentation.tables ?? {}).flatMap(([id, t]) =>
      t.stateField ? [[id, t.stateField] as const] : [],
    ),
  );
  return {
    presentation,
    graph,
    index,
    layout,
    recording,
    timeline,
    stateFields,
    stateAt: (t) => stateAt(timeline, t, stateFields),
  };
}

function layOut(graph: Graph, presentation: Presentation): Layout {
  const strategy = LAYOUTS[presentation.layout ?? "islands"];
  if (!strategy) throw new Error(`No layout named "${presentation.layout}".`);
  return strategy(graph, presentation);
}
