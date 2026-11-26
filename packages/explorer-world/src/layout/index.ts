import { islandsLayout } from "./islands.ts";
import type { LayoutStrategy } from "./types.ts";

/** The layout strategies, by name. A presentation picks one with `layout`. */
export const LAYOUTS: Record<string, LayoutStrategy> = {
  islands: islandsLayout,
};

export type { Layout, LayoutStrategy } from "./types.ts";
