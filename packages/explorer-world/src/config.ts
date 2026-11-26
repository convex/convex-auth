/**
 * How a project looks in the world. A project supplies one of these with its
 * structure and recording (see `src/project.ts`); the renderer reads nothing
 * else that is specific to a codebase. Every field is optional except the
 * title: whatever is missing gets a default.
 */
import type { Doc, Recording, Structure } from "./model/types.ts";

export type Vec3 = [x: number, y: number, z: number];

export interface ProjectConfig {
  title: string;
  subtitle?: string;
  /** Per region: its accent color, and where its island floats. */
  regions?: Record<
    string,
    {
      color?: string;
      center?: Vec3;
      radius?: number;
      /** The tokens it holds are copies of someone else's; drawn in its color. */
      holdsCopies?: boolean;
    }
  >;
  /** Per place: where it stands on the platform. */
  places?: Record<string, { position: Vec3 }>;
  /** Per value of a table's state field: the color of its rows. */
  states?: Record<string, { color: string; retired?: boolean }>;
  /** Per token kind: how it is drawn. */
  tokens?: Record<string, { shape: "coin" | "key"; color: string }>;
  camera?: { position: Vec3; target: Vec3 };
  /** A second line on the card of a row of a table with a state field. */
  rowCaption?: (table: string, doc: Doc) => string | undefined;
}

/** Everything the world needs from a project. */
export interface Project {
  config: ProjectConfig;
  structure: Structure;
  recording: Recording;
}

const FALLBACK_COLORS = [
  "#6aa8ff",
  "#3fe0d0",
  "#ffb454",
  "#7ee081",
  "#b48cff",
  "#ff7a45",
  "#ff4f7b",
];

export function regionColor(
  config: ProjectConfig,
  structure: Structure,
  id: string,
): string {
  const configured = config.regions?.[id]?.color;
  if (configured) return configured;
  const i = structure.regions.findIndex((r) => r.id === id);
  return FALLBACK_COLORS[Math.max(0, i) % FALLBACK_COLORS.length];
}

export function stateColor(
  config: ProjectConfig,
  state: string | undefined,
): string | undefined {
  return state ? config.states?.[state]?.color : undefined;
}

export function tokenLook(
  config: ProjectConfig,
  kind: string,
): { shape: "coin" | "key"; color: string } {
  return config.tokens?.[kind] ?? { shape: "key", color: "#cfe6ff" };
}
