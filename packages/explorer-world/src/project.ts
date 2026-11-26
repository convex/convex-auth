/**
 * Loads a project into a world. A project is a directory under `projects/`
 * whose `index.ts` exports a `ProjectSource`: its structure map, its recorded
 * timeline, and its presentation. Nothing else is needed: a new directory is
 * found on its own (`?project=<name>` picks it, the first one otherwise).
 */
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
  /** The recorder's timeline, NDJSON. */
  timeline: string;
}

export function resolvePresentation(own: Presentation): Presentation {
  if (!own.extends) return own;
  const base = PRESETS[own.extends];
  if (!base) throw new Error(`No preset named "${own.extends}".`);
  return extendPresentation(resolvePresentation(base), own);
}

export function loadProject(source: ProjectSource): World {
  const presentation = resolvePresentation(source.presentation);
  const structure = graphFromStructure(source.structure, presentation);
  const { recording, observed } = recordingFromTimeline(
    parseNdjson(source.timeline),
    structure,
    presentation,
  );
  return createWorld(
    withObserved(structure, observed),
    recording,
    presentation,
  );
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
