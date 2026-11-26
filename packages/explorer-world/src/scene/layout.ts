/**
 * Where everything sits in the world. Derived from the structure, so a new
 * function or table finds a place without editing this file. A project can
 * place its islands and places by hand in its config; whatever it leaves out
 * is placed automatically.
 */
import { Vector3 } from "three";
import type { ProjectConfig } from "../config.ts";
import type { Anchor } from "../model/schedule.ts";
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
  /** Where each place stands, on the floor. */
  places: Map<string, Vector3>;
  /** The places requests pass through, rather than stop at. */
  entries: Set<string>;
  platform: { center: Vector3; radius: number };
  overview: { position: Vector3; target: Vector3 };
}

export const FUNCTION_HEIGHT = 2.2;
export const ROW = { width: 2.3, depth: 1.5, gap: 0.35 };

export function createLayout(
  structure: Structure,
  config: ProjectConfig,
): Layout {
  const islands = new Map<string, IslandLayout>();
  const drawn = structure.regions.filter((r) => r.kind !== "platform");
  const services = drawn.filter((r) => r.kind === "service");
  const clients = drawn.filter((r) => r.kind === "client");
  for (const r of drawn) {
    const spec = config.regions?.[r.id];
    const contents =
      structure.functions.filter((f) => f.region === r.id).length +
      structure.tables.filter((t) => t.region === r.id).length;
    const radius =
      spec?.radius ?? (r.kind === "client" ? 6 : 4 + contents * 0.9);
    let center: Vector3;
    if (spec?.center) {
      center = new Vector3(...spec.center);
    } else if (r.kind === "client") {
      // Clients wait outside, on the left.
      center = new Vector3(
        -60,
        2,
        clients.indexOf(r) * 18 - (clients.length - 1) * 9,
      );
    } else {
      // Services stand in a ring.
      const a =
        (services.indexOf(r) / Math.max(1, services.length)) * Math.PI * 2;
      const ring = 10 + services.length * 6;
      center = new Vector3(Math.cos(a) * ring, 2, Math.sin(a) * ring);
    }
    islands.set(r.id, { id: r.id, center, radius });
  }

  // The platform's floor spans the services.
  const placed = services.map((r) => islands.get(r.id)!);
  const minX = Math.min(...placed.map((i) => i.center.x - i.radius));
  const maxX = Math.max(...placed.map((i) => i.center.x + i.radius));
  const minZ = Math.min(...placed.map((i) => i.center.z - i.radius));
  const maxZ = Math.max(...placed.map((i) => i.center.z + i.radius));
  const floor = new Vector3(
    (minX + maxX) / 2,
    Math.min(...placed.map((i) => i.center.y)) - 3,
    (minZ + maxZ) / 2,
  );
  const floorRadius =
    Math.max(
      ...placed.map(
        (i) =>
          Math.hypot(i.center.x - floor.x, i.center.z - floor.z) + i.radius,
      ),
    ) + 3;

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

  const places = new Map<string, Vector3>();
  structure.places.forEach((p, i) => {
    const spec = config.places?.[p.id];
    if (spec) places.set(p.id, new Vector3(...spec.position));
    else if (p.role === "entry")
      places.set(p.id, new Vector3(floor.x - floorRadius, 0, floor.z));
    else
      places.set(
        p.id,
        new Vector3(
          floor.x - floorRadius * 0.6,
          0,
          floor.z + floorRadius * (0.3 + i * 0.15),
        ),
      );
  });

  const camera = config.camera;
  return {
    islands,
    functions,
    tables,
    places,
    entries: new Set(
      structure.places.filter((p) => p.role === "entry").map((p) => p.id),
    ),
    platform: { center: floor, radius: floorRadius },
    overview: camera
      ? {
          position: new Vector3(...camera.position),
          target: new Vector3(...camera.target),
        }
      : {
          position: floor
            .clone()
            .add(
              new Vector3(
                -0.3 * floorRadius,
                1.3 * floorRadius,
                1.9 * floorRadius,
              ),
            ),
          target: floor.clone().setY(0),
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
    if (layout.entries.has(anchor)) return place.clone().setY(place.y + 3.2);
    return place.clone().setY(place.y + 5);
  }
  return new Vector3();
}
