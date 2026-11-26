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
} from "./adapters/convexRecording.ts";
import { createWorld, type World } from "./model/world.ts";
import { PRESETS } from "./presets.ts";
import { extendPresentation, type Presentation } from "./presentation.ts";

export interface ProjectSource {
  presentation: Presentation;
  structure: StructureInput;
  /** The recorder's timelines (NDJSON), by name; the first is the default. */
  timelines: Record<string, string>;
}

export function resolvePresentation(own: Presentation): Presentation {
  if (!own.extends) return own;
  const base = PRESETS[own.extends];
  if (!base) throw new Error(`No preset named "${own.extends}".`);
  return extendPresentation(resolvePresentation(base), own);
}

/** Loads a project with one of its recordings, by name (the first by default). */
export function loadProject(source: ProjectSource, chosen?: string): World {
  const name =
    chosen && chosen in source.timelines
      ? chosen
      : Object.keys(source.timelines)[0];
  const own = resolvePresentation(source.presentation);
  const structure = graphFromStructure(source.structure, own);
  const presentation = withKindLabels(own, structure.kinds?.parts ?? {});
  const { recording, observed } = recordingFromTimeline(
    parseNdjson(source.timelines[name] ?? ""),
    structure,
    presentation,
    (app) =>
      joinRecording(
        source.structure as Parameters<typeof joinRecording>[0],
        app,
      ),
  );
  return createWorld(
    withObserved(structure, observed),
    { ...recording, name },
    presentation,
  );
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
