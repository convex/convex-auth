import convex from "../presets/convex.json";
import type { Presentation } from "./presentation.ts";

/** The presets a presentation can extend, by name. */
export const PRESETS: Record<string, Presentation> = {
  convex: convex as Presentation,
};
