import type { Project } from "../../src/config.ts";
import { loadRecording, loadStructure } from "./adapter.ts";
import { config } from "./config.ts";

export const project: Project = {
  config,
  structure: loadStructure(),
  recording: loadRecording(),
};
