/** The project's colors and shapes, with defaults for what it leaves out. */
import { regionColor, stateColor, tokenLook } from "../config.ts";
import { config, world } from "../store.ts";

export const regionColorOf = (id: string) =>
  regionColor(config, world.structure, id);
export const stateColorOf = (state: string | undefined) =>
  stateColor(config, state);
export const tokenLookOf = (kind: string) => tokenLook(config, kind);
export const isRetired = (state: string | undefined) =>
  Boolean(state && config.states?.[state]?.retired);
export const tokenNounOf = (kind: string) =>
  world.structure.tokens.find((k) => k.kind === kind)?.label ?? "token";

/** The region drawn as the floor, if the structure has one. */
export const platformRegion = world.structure.regions.find(
  (r) => r.kind === "platform",
);
