import { GENERIC_PROJECT, type ProjectConfig } from "../project.ts";
import { convexAuthProject } from "./convexAuth.ts";

/** The project configs that `--project` names. */
export const PROJECTS: Readonly<Record<string, ProjectConfig>> = {
  generic: GENERIC_PROJECT,
  "convex-auth": convexAuthProject,
};
