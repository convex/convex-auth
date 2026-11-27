/**
 * Loads a project into a world. A project is a directory under `projects/`
 * whose `index.ts` exports a `ProjectSource`: its structure map, its recorded
 * timeline, and its presentation. Nothing else is needed: a new directory is
 * found on its own (`?project=<name>` picks it, the first one otherwise).
 */
import { joinRecording } from "@convex-dev/explorer-structure";
import {
  graphFromStructure,
  type StructureInput,
} from "./adapters/convexStructure.ts";
import {
  parseNdjson,
  recordingFromTimeline,
  withObserved,
  type Event,
} from "./adapters/convexRecording.ts";
import type { Graph } from "./model/graph.ts";
import type { ProjectInside } from "./model/inside.ts";
import { createWorld, type World } from "./model/world.ts";
import { PRESETS } from "./presets.ts";
import { extendPresentation, type Presentation } from "./presentation.ts";

export interface ProjectSource {
  presentation: Presentation;
  structure: StructureInput;
  /** The recorder's timelines (NDJSON), by name; the first is the default. */
  timelines: Record<string, string>;
  /**
   * What the project says of the insides of its parts (what a module
   * exports and holds, where it reports steps), if it says anything.
   */
  inside?: ProjectInside;
}

export function resolvePresentation(own: Presentation): Presentation {
  if (!own.extends) return own;
  const base = PRESETS[own.extends];
  if (!base) throw new Error(`No preset named "${own.extends}".`);
  return extendPresentation(resolvePresentation(base), own);
}

/** A project's structure and presentation, ready to take recordings. */
export interface PreparedProject {
  source: ProjectSource;
  structure: Graph;
  presentation: Presentation;
}

export function prepareProject(source: ProjectSource): PreparedProject {
  const own = resolvePresentation(source.presentation);
  const structure = graphFromStructure(source.structure, own);
  const presentation = withKindLabels(own, structure.kinds?.parts ?? {});
  return { source, structure, presentation };
}

/**
 * The world of a recording given as its events, laid out around the app the
 * recording ran in (its `recording` event's `app`; with none, the
 * presentation's `focus`). With `previous`, a world of the same project, the
 * layout is reused when the recording adds no part to the map that
 * `previous` lacks and runs in the same app; `relaidOut` says whether it was
 * laid out again.
 */
export function worldFromEvents(
  project: PreparedProject,
  events: Event[],
  name: string,
  previous?: World,
): { world: World; relaidOut: boolean } {
  const { source, structure, presentation } = project;
  const { recording, observed } = recordingFromTimeline(
    events,
    structure,
    presentation,
    (app) =>
      joinRecording(
        source.structure as Parameters<typeof joinRecording>[0],
        app,
      ),
  );
  const graph = withObserved(structure, observed);
  // The world is laid out around the app the recording runs in: it is what
  // the page calls.
  const focus =
    recording.app && graph.parts.some((p) => p.id === `app:${recording.app}`)
      ? `app:${recording.app}`
      : presentation.focus;
  const same =
    previous !== undefined &&
    previous.presentation.focus === focus &&
    previous.graph.parts.length === graph.parts.length &&
    observed.every((part) => previous.index.part.has(part.id));
  return {
    world: createWorld(
      same ? previous.graph : graph,
      { ...recording, name },
      { ...presentation, focus },
      same ? previous.layout : undefined,
    ),
    relaidOut: !same,
  };
}

/** Loads a project with one of its recordings, by name (the first by default). */
export function loadProject(source: ProjectSource, chosen?: string): World {
  const name =
    chosen && chosen in source.timelines
      ? chosen
      : Object.keys(source.timelines)[0];
  return worldFromEvents(
    prepareProject(source),
    parseNdjson(source.timelines[name] ?? ""),
    name,
  ).world;
}

/**
 * A kind of part the presentation does not describe still gets the noun the
 * data gives it, drawn as a marker.
 */
function withKindLabels(
  p: Presentation,
  labels: Record<string, { label: string }>,
): Presentation {
  const kinds = { ...p.kinds };
  for (const [kind, { label }] of Object.entries(labels))
    kinds[kind] ??= { shape: "marker", noun: label.toLowerCase() };
  return { ...p, kinds };
}

const byDirectory = (found: Record<string, { source: ProjectSource }>) =>
  Object.entries(found).map(
    ([path, m]) => [path.split("/").slice(-2)[0], m.source] as const,
  );

/**
 * The projects under `projects/`, then the made-up ones under `fixtures/`
 * (which tests use), by directory name.
 */
export const PROJECTS: Record<string, ProjectSource> = Object.fromEntries([
  ...byDirectory(
    import.meta.glob<{ source: ProjectSource }>("../projects/*/index.ts", {
      eager: true,
    }),
  ),
  ...byDirectory(
    import.meta.glob<{ source: ProjectSource }>("../fixtures/*/index.ts", {
      eager: true,
    }),
  ),
]);
