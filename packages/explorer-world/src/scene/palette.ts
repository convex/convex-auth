/**
 * The colors of the world that do not depend on the project. A project's own
 * colors (regions, row states, tokens) come from its `ProjectConfig`; see
 * `look.ts`.
 */
export const BACKGROUND = "#04060c";

/** The floor of the platform: the deployment the islands run on. */
export const PLATFORM_COLOR = "#8a7dff";

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
  schedule: "#c3b5ff",
  write: "#ffb454",
};

/** A page's sign-in state, as its client library reports it. */
export const STATE_COLORS: Record<string, string> = {
  loading: "#6f7c99",
  signedOut: "#8fa3c8",
  signingIn: "#ffd36b",
  signedIn: "#5dffb0",
  error: "#ff3b5c",
};
