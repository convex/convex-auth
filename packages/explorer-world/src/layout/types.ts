/**
 * A layout places every part of a graph in the world. It is a strategy: one
 * function from the graph and the presentation to placements, so another
 * spatial idea (a flow from clients to tables, stacked layers) is a new
 * function, not a rewrite. The scene draws whatever a layout returns.
 */
import type { Graph } from "../model/graph.ts";
import type { Presentation, Profile, Shape, Zone } from "../presentation.ts";

export type Vec3 = [x: number, y: number, z: number];

export interface Placement {
  id: string;
  shape: Shape;
  /** The center of its base, on the ground it stands on. */
  position: Vec3;
  /** The radius of its footprint. */
  radius: number;
  /** The island it stands on, if any. */
  island: string | null;
  color: string;
  profile?: Profile;
}

/** A group of parts on an island that share a parent from elsewhere. */
export interface Cluster {
  /** The id of the part the group belongs to (it may live elsewhere). */
  id: string;
  center: Vec3;
  radius: number;
}

export interface IslandPlacement extends Placement {
  shape: "island";
  zone: Zone;
  /** 0 for an island of its own, 1 for one on another island, and so on. */
  depth: number;
  /** The island it rises from, if any. */
  parentIsland: string | null;
  /** The parts standing on it. */
  members: string[];
  clusters: Cluster[];
}

export interface Layout {
  strategy: string;
  /** Every placed part, islands included. */
  parts: Map<string, Placement>;
  /** The islands, parents before children. */
  islands: IslandPlacement[];
  /** The floor the platform islands stand on. */
  platform: { center: Vec3; radius: number };
  overview: { position: Vec3; target: Vec3 };
  /**
   * The view Home returns to: the region a recorded page runs in
   * (`presentation.client`), with the world beyond it toward the platform.
   * Absent when there is no such region; Home is the overview then.
   */
  home?: {
    position: Vec3;
    target: Vec3;
    /** The region on the ground, for the camera to fit to the window. */
    region: { center: Vec3; radius: number };
    /**
     * The island the region's calls land on first: the one holding the
     * presentation's `focus` (the app the page runs against). Home keeps it
     * in view too when the region still gets most of the window.
     */
    beyond?: { center: Vec3; radius: number };
  };
  /** Parts the layout could not place, with the reason. */
  unplaced: { id: string; reason: string }[];
}

export type LayoutStrategy = (
  graph: Graph,
  presentation: Presentation,
) => Layout;
