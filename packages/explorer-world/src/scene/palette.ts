/**
 * The colors of the world that do not depend on the project. A project's own
 * colors (regions, row states, tokens) come from its `ProjectConfig`; see
 * `look.ts`.
 */
export const BACKGROUND = "#04060c";

/** A row being deleted, whatever its table. */
export const DELETED_COLOR = "#ff3b5c";

export const TONE_COLORS = {
  normal: "#cfe6ff",
  warn: "#ffb020",
  error: "#ff3b5c",
};

export const MOVEMENT_COLORS: Record<string, string> = {
  request: "#9fd0ff",
  response: "#c6ffdf",
  call: "#d6b8ff",
  return: "#b8f5ea",
  sign: "#ffd36b",
  schedule: "#c3b5ff",
};
