/** How the Convex Auth slice looks in the world. */
import type { ProjectConfig } from "../../src/config.ts";

export const config: ProjectConfig = {
  title: "Convex Auth",
  subtitle: "username + password",
  regions: {
    browser: { color: "#6aa8ff", center: [-44, 2, 10], radius: 7 },
    elsewhere: {
      color: "#ff4f7b",
      center: [-50, 3, -20],
      radius: 4,
      holdsCopies: true,
    },
    platform: { color: "#8a7dff" },
    app: { color: "#b48cff", center: [-8, 0, 8], radius: 10 },
    authUsername: { color: "#7ee081", center: [-20, 4, -22], radius: 7.5 },
    auth: { color: "#3fe0d0", center: [6, 5, -26], radius: 13 },
    authPassword: { color: "#ffb454", center: [26, 4, -2], radius: 8 },
    "authPassword/rateLimiter": {
      color: "#ff7a45",
      center: [38, 7, -18],
      radius: 4.5,
    },
  },
  places: {
    "platform:gate": { position: [-29, 0, 9] },
    "platform:signer": { position: [-24, 0, -1] },
    "platform:scheduler": { position: [9, 0, -4] },
  },
  // The lifecycle of a refresh token (auth.refreshTokens.state).
  states: {
    issued: { color: "#47e6ff" },
    redeemed: { color: "#ffc24a" },
    spent: { color: "#8f3a55", retired: true },
    dropped: { color: "#5b6275", retired: true },
  },
  tokens: {
    access: { shape: "coin", color: "#ffd36b" },
    refresh: { shape: "key", color: "#47e6ff" },
  },
  camera: { position: [-16, 54, 80], target: [-6, 0, -8] },
  rowCaption: (table, doc) =>
    table === "auth:refreshTokens" && doc.sessionId
      ? `session ${String(doc.sessionId).replace(/^s/, "")}`
      : undefined,
};
