/**
 * Where everything sits in the world. Derived from the structure, so a new
 * function or table finds a place without editing this file; only the
 * islands themselves are placed by hand.
 */
import { Vector3 } from "three";
import { GATE, SCHEDULER, SIGNER, type Anchor } from "../model/schedule.ts";
import type { Structure } from "../model/types.ts";

export interface IslandLayout {
  id: string;
  center: Vector3;
  radius: number;
}

export interface NodeLayout {
  id: string;
  region: string;
  position: Vector3;
}

export interface TableLayout extends NodeLayout {
  featured: boolean;
  /** Rows per line of the vault. */
  columns: number;
  width: number;
  depth: number;
}

export interface Layout {
  islands: Map<string, IslandLayout>;
  functions: Map<string, NodeLayout>;
  tables: Map<string, TableLayout>;
  places: Map<string, Vector3>;
  platform: { center: Vector3; radius: number };
  overview: { position: Vector3; target: Vector3 };
}

const ISLANDS: Record<
  string,
  { center: [number, number, number]; radius: number }
> = {
  browser: { center: [-44, 2, 10], radius: 7 },
  elsewhere: { center: [-50, 3, -20], radius: 4 },
  app: { center: [-8, 0, 8], radius: 10 },
  authUsername: { center: [-20, 4, -22], radius: 7.5 },
  auth: { center: [6, 5, -26], radius: 13 },
  authPassword: { center: [26, 4, -2], radius: 8 },
  "authPassword/rateLimiter": { center: [38, 7, -18], radius: 4.5 },
};

export const FUNCTION_HEIGHT = 2.2;
export const ROW = { width: 2.3, depth: 1.5, gap: 0.35 };

export function createLayout(structure: Structure): Layout {
  const islands = new Map<string, IslandLayout>();
  for (const r of structure.regions) {
    const spec = ISLANDS[r.id];
    if (spec) {
      islands.set(r.id, {
        id: r.id,
        center: new Vector3(...spec.center),
        radius: spec.radius,
      });
    }
  }

  const functions = new Map<string, NodeLayout>();
  const tables = new Map<string, TableLayout>();
  for (const island of islands.values()) {
    const fns = structure.functions.filter((f) => f.region === island.id);
    const tbls = structure.tables.filter((t) => t.region === island.id);
    const { center, radius } = island;
    // Functions stand in an arc along the front edge (toward +z).
    const spread = Math.min(2.4, 0.55 * fns.length);
    fns.forEach((f, i) => {
      const a =
        fns.length === 1 ? 0 : -spread / 2 + (spread * i) / (fns.length - 1);
      const r = radius * 0.78;
      functions.set(f.id, {
        id: f.id,
        region: island.id,
        position: new Vector3(
          center.x + r * Math.sin(a),
          center.y,
          center.z + r * Math.cos(a),
        ),
      });
    });
    // A table with a lifecycle sits in the middle; the others along the back.
    const plain = tbls.filter((t) => !t.stateField);
    tbls.forEach((t) => {
      const featured = Boolean(t.stateField);
      const columns = featured ? 4 : 2;
      const width = columns * (ROW.width + ROW.gap) + ROW.gap + 0.6;
      const depth = ROW.depth + 2 * ROW.gap + 0.6;
      let position: Vector3;
      if (featured) {
        position = new Vector3(center.x, center.y, center.z + radius * 0.12);
      } else {
        // The other tables stand in a line along the back.
        const i = plain.indexOf(t);
        const n = plain.length;
        const alone = fns.length === 0 && tbls.length === 1;
        const step = width + 0.9;
        const z = alone
          ? 0
          : -radius * (tbls.some((x) => x.stateField) ? 0.42 : 0.3);
        position = new Vector3(
          center.x + (i - (n - 1) / 2) * step,
          center.y,
          center.z + z,
        );
      }
      tables.set(t.id, {
        id: t.id,
        region: island.id,
        position,
        featured,
        columns,
        width,
        depth,
      });
    });
  }

  const app = islands.get("app")!.center;
  const places = new Map<string, Vector3>([
    [GATE, new Vector3(-29, 3.2, 9)],
    [SIGNER, new Vector3(-24, 0, -1)],
    [SCHEDULER, new Vector3(app.x + 17, 0, app.z - 12)],
  ]);

  return {
    islands,
    functions,
    tables,
    places,
    platform: { center: new Vector3(10, -3, -8), radius: 39 },
    overview: {
      position: new Vector3(-16, 54, 80),
      target: new Vector3(-6, 0, -8),
    },
  };
}

/** The point an anchor stands for: where a traveller leaves or arrives. */
export function anchorPosition(layout: Layout, anchor: Anchor): Vector3 {
  const fn = layout.functions.get(anchor);
  if (fn)
    return fn.position.clone().setY(fn.position.y + FUNCTION_HEIGHT + 0.6);
  const table = layout.tables.get(anchor);
  if (table) return table.position.clone().setY(table.position.y + 1.2);
  const island = layout.islands.get(anchor);
  if (island) return island.center.clone().setY(island.center.y + 3.2);
  const place = layout.places.get(anchor);
  if (place) {
    if (anchor === GATE) return place.clone();
    return place.clone().setY(place.y + 5);
  }
  return new Vector3();
}
