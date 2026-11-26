/**
 * Convex Auth: the structure map from `@convex-dev/explorer-structure`, a
 * recording of the username-password example (`recording.ndjson`, made with
 * `@convex-dev/explorer`), and how its parts look (`presentation.json`).
 */
import { structure } from "@convex-dev/explorer-structure";
import type { ProjectSource } from "../../src/project.ts";
import type { Presentation } from "../../src/presentation.ts";
import presentation from "./presentation.json";
import timeline from "./recording.ndjson?raw";

export const source: ProjectSource = {
  presentation: presentation as Presentation,
  structure,
  timeline,
};
