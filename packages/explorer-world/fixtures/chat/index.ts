/**
 * A made-up Convex app: a chat app with one component, `presence`. It is not
 * real code; it exists to prove that the world shows any Convex project from
 * its data alone (see `src/test/fixture.test.ts`). `?project=chat` opens it.
 */
import type { StructureInput } from "../../src/adapters/convexStructure.ts";
import type { Presentation } from "../../src/presentation.ts";
import type { ProjectSource } from "../../src/project.ts";
import presentation from "./presentation.json";
import timeline from "./recording.ndjson?raw";
import structure from "./structure.json";

export const source: ProjectSource = {
  presentation: presentation as Presentation,
  structure: structure as StructureInput,
  timeline,
};
