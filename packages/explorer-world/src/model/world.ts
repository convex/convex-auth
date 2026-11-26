import { stateAt, type WorldState } from "./playback.ts";
import { buildTimeline, type Timeline } from "./schedule.ts";
import type { Recording, Structure } from "./types.ts";

export interface World {
  structure: Structure;
  recording: Recording;
  timeline: Timeline;
  stateFields: Map<string, string>;
  stateAt: (t: number) => WorldState;
}

export function createWorld(structure: Structure, recording: Recording): World {
  const timeline = buildTimeline(structure, recording);
  const stateFields = new Map(
    structure.tables.flatMap((t) =>
      t.stateField ? [[t.id, t.stateField] as const] : [],
    ),
  );
  return {
    structure,
    recording,
    timeline,
    stateFields,
    stateAt: (t) => stateAt(timeline, t, stateFields),
  };
}
