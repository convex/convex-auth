/**
 * The insides of the parts of the current project, and what its parts have
 * done in the current recording, computed once per timeline.
 */
import { doneIn, type Done } from "./model/done.ts";
import type { PartInside } from "./model/inside.ts";
import type { Timeline } from "./model/schedule.ts";
import { project, world } from "./store.ts";

/** What the project says of a part's inside, if anything. */
export const insideOf = (id: string): PartInside | undefined =>
  project.source.inside?.parts[id];

const cache = new WeakMap<Timeline, Done>();

/** What running code did, in the current recording. */
export function done(): Done {
  let d = cache.get(world.timeline);
  if (!d) {
    d = doneIn(world.recording, world.timeline, project.source.inside);
    cache.set(world.timeline, d);
  }
  return d;
}
