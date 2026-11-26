/** Colors of the world. One accent per trust boundary, one per token state. */
export const BACKGROUND = "#04060c";

export const REGION_COLORS: Record<string, string> = {
  browser: "#6aa8ff",
  elsewhere: "#ff4f7b",
  platform: "#8a7dff",
  app: "#b48cff",
  auth: "#3fe0d0",
  authPassword: "#ffb454",
  "authPassword/rateLimiter": "#ff7a45",
  authUsername: "#7ee081",
};

export const STATE_COLORS: Record<string, string> = {
  issued: "#47e6ff",
  redeemed: "#ffc24a",
  spent: "#8f3a55",
  dropped: "#5b6275",
  deleted: "#ff3b5c",
};

export const TONE_COLORS = {
  normal: "#cfe6ff",
  warn: "#ffb020",
  error: "#ff3b5c",
};

export const TOKEN_COLORS = {
  access: "#ffd36b",
  refresh: "#47e6ff",
};

export const MOVEMENT_COLORS: Record<string, string> = {
  request: "#9fd0ff",
  response: "#c6ffdf",
  call: "#d6b8ff",
  return: "#b8f5ea",
  sign: "#ffd36b",
  schedule: "#c3b5ff",
};
