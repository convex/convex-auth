/**
 * The islands strategy: trust boundaries as floating islands.
 *
 * - Parts whose kind is drawn as an island (an app, a component, a region)
 *   are islands. An island inside another one (a child component, the apps of
 *   a region) rises from its parent as a plateau.
 * - Every other part stands on the nearest island among its ancestors, or on
 *   the island its kind's `placeIn` names (client code in the region it runs
 *   in). Parts that share a parent from elsewhere stand together in a
 *   cluster, so client code still reads by sign-in method.
 * - Top-level islands float by zone: the platform islands on a disc, the
 *   client islands to its left, the external parts to its right. A top-level
 *   part that is not an island and has no zone (a caller) stands on the rim
 *   of the platform, facing the clients.
 *
 * Everything is computed from the graph: a new part finds a place without any
 * code change. Pure (no three.js), so it is tested directly.
 */
import { indexGraph, type GraphIndex, type Part } from "../model/graph.ts";
import {
  fill,
  kindLook,
  paletteColor,
  partValues,
  type Shape,
  type Zone,
} from "../presentation.ts";
import type {
  Cluster,
  IslandPlacement,
  Layout,
  LayoutStrategy,
  Placement,
  Vec3,
} from "./types.ts";

/** The footprint of each shape, before the kind's `size`. */
export const FOOTPRINT: Record<Shape, number> = {
  island: 4,
  vault: 2.4,
  pillar: 0.95,
  obelisk: 1.05,
  gate: 1.2,
  post: 0.6,
  shard: 0.75,
  beacon: 3,
  marker: 0.7,
  state: 1.6,
};
/** Inner parts first, so tables sit in the middle of an island. */
const ORDER: Record<Shape, number> = {
  vault: 0,
  pillar: 1,
  obelisk: 1,
  shard: 2,
  gate: 3,
  post: 4,
  marker: 5,
  state: 0,
  beacon: 6,
  island: 8,
};
const GAP = 0.55;
const MARGIN = 1.6;
/** How high a child island rises above its parent. */
const PLATEAU = 0.9;

interface Circle {
  r: number;
  x: number;
  z: number;
}

/**
 * Greedy packing: each circle in turn takes the free spot nearest the
 * middle, sweeping from `start` (radians from +x toward +z; the front by
 * default, so the first circles face the viewer). The result is centered.
 */
export function packCircles(
  radii: number[],
  gap = GAP,
  start = Math.PI / 2,
  /** Center the group on its bounds; else the first circle stays at the middle. */
  centered = true,
): Circle[] {
  return pack(
    radii.map((r) => ({ r, start })),
    gap,
    centered,
  );
}

interface Packed {
  r: number;
  /** Where its sweep starts (radians from +x toward +z). */
  start: number;
  /** Spots it may not take, as the direction from the middle (radians). */
  avoid?: { angle: number; half: number };
}

const angleBetween = (a: number, b: number) =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** {@link packCircles}, with each circle's own start and a wedge it avoids. */
function pack(items: Packed[], gap: number, centered: boolean): Circle[] {
  const placed: Circle[] = [];
  for (const { r, start, avoid } of items) {
    if (!placed.length) {
      placed.push({ r, x: 0, z: 0 });
      continue;
    }
    const fits = (x: number, z: number) =>
      placed.every((c) => Math.hypot(c.x - x, c.z - z) >= c.r + r + gap) &&
      // The whole circle stays out of the wedge.
      (!avoid ||
        angleBetween(Math.atan2(z, x), avoid.angle) >
          avoid.half +
            Math.asin(Math.min(1, r / Math.max(r, Math.hypot(x, z)))));
    let done: Circle | null = null;
    const step = Math.max(0.25, Math.min(r, 1) * 0.5);
    // Beyond every placed circle each spot is free (outside the wedge), so the sweep ends.
    for (let d = Math.max(0, placed[0].r + r + gap - 0.01); !done; d += step) {
      const n = Math.max(6, Math.ceil((2 * Math.PI * d) / step));
      for (let k = 0; k < n; k++) {
        // Alternate around the start: 0, +1, -1, +2, -2, ...
        const j = k % 2 ? (k + 1) / 2 : -k / 2;
        const a = start + (j * 2 * Math.PI) / n;
        const x = d * Math.cos(a);
        const z = d * Math.sin(a);
        if (fits(x, z)) {
          done = { r, x, z };
          break;
        }
      }
    }
    placed.push(done);
  }
  // Center the group on the middle of its bounds.
  if (centered && placed.length > 1) {
    const x0 = Math.min(...placed.map((c) => c.x - c.r));
    const x1 = Math.max(...placed.map((c) => c.x + c.r));
    const z0 = Math.min(...placed.map((c) => c.z - c.r));
    const z1 = Math.max(...placed.map((c) => c.z + c.r));
    for (const c of placed) {
      c.x -= (x0 + x1) / 2;
      c.z -= (z0 + z1) / 2;
    }
  }
  return placed;
}

/** Room between the columns of a flow, and between the nodes of a column. */
const FLOW_GAP = 7;
const COLUMN_GAP = 3;

/**
 * Nodes in columns by their `flow`, left to right (+x, toward the
 * platform), each column stacked front to back and centered; the nodes
 * without a flow make the column after the last. The result is centered.
 */
function flowColumns(nodes: Node[]): Circle[] {
  const last = Math.max(...nodes.map((n) => n.flow ?? -Infinity));
  const columnOf = (n: Node) => n.flow ?? last + 1;
  const columns = [...new Set(nodes.map(columnOf))].sort((a, b) => a - b);
  const out: Circle[] = nodes.map((n) => ({ r: n.r, x: 0, z: 0 }));
  let x = 0;
  for (const c of columns) {
    const members = nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => columnOf(n) === c);
    const width = Math.max(...members.map(({ n }) => n.r));
    const height =
      members.reduce((s, { n }) => s + 2 * n.r, 0) +
      COLUMN_GAP * (members.length - 1);
    let z = -height / 2;
    for (const { n, i } of members) {
      out[i] = { r: n.r, x: x + width, z: z + n.r };
      z += 2 * n.r + COLUMN_GAP;
    }
    x += 2 * width + FLOW_GAP;
  }
  const x0 = Math.min(...out.map((c) => c.x - c.r));
  const x1 = Math.max(...out.map((c) => c.x + c.r));
  for (const c of out) c.x -= (x0 + x1) / 2;
  return out;
}

/**
 * Circles packed with the one at `first` on the rim toward the clients
 * (-x): the others pack from the far side (+x), then it stands just
 * outside them, level with the group's middle. The result is centered.
 */
function nearRim(radii: number[], first: number): Circle[] {
  const rest = radii.flatMap((r, i) => (i === first ? [] : [{ r, i }]));
  const packed = packCircles(
    rest.map((x) => x.r),
    GAP,
    0,
  );
  const out: Circle[] = radii.map((r) => ({ r, x: 0, z: 0 }));
  rest.forEach(({ i }, k) => (out[i] = packed[k]));
  // Just past the nearest circle in its row, so it touches the group.
  const r = radii[first];
  const z = 0;
  const x = Math.min(
    ...packed.map((c) => {
      const dz = Math.abs(c.z - z);
      const reach = c.r + r + GAP * 2;
      return dz >= reach ? Infinity : c.x - Math.sqrt(reach * reach - dz * dz);
    }),
  );
  out[first] = { r, x: Number.isFinite(x) ? x : -r, z };
  const x0 = Math.min(...out.map((c) => c.x - c.r));
  const x1 = Math.max(...out.map((c) => c.x + c.r));
  const z0 = Math.min(...out.map((c) => c.z - c.r));
  const z1 = Math.max(...out.map((c) => c.z + c.r));
  for (const c of out) {
    c.x -= (x0 + x1) / 2;
    c.z -= (z0 + z1) / 2;
  }
  return out;
}

/** The radius of the smallest circle around the origin holding them all. */
function enclosing(circles: Circle[]): number {
  return Math.max(0, ...circles.map((c) => Math.hypot(c.x, c.z) + c.r));
}

interface Node {
  id: string;
  r: number;
  order: number;
  /** How much of its district depends on it (see `heart`); 1 when unknown. */
  weight?: number;
  flow?: number;
  /** Positions relative to the node's center, filled by `arrange`. */
  layoutChildren?: (origin: Vec3) => void;
}

export const islandsLayout: LayoutStrategy = (graph, presentation) => {
  const index = indexGraph(graph);
  const look = (p: Part) => kindLook(presentation, p.kind);
  const isIsland = (p: Part) => look(p).shape === "island";
  const zoneOf = (p: Part): Zone | undefined =>
    presentation.parts?.[p.id]?.zone ?? look(p).zone;

  const nearestIsland = (p: Part): Part | null => {
    let q = p.parent ? index.part.get(p.parent) : undefined;
    const seen = new Set<string>();
    while (q && !seen.has(q.id)) {
      if (isIsland(q)) return q;
      seen.add(q.id);
      q = q.parent ? index.part.get(q.parent) : undefined;
    }
    return null;
  };
  /** Where a part is drawn: its kind's `placeIn`, or its nearest island. */
  const homeOf = (p: Part): Part | null => {
    const template = look(p).placeIn;
    if (template) {
      const target = index.part.get(fill(template, partValues(p)));
      if (target && isIsland(target)) return target;
    }
    return nearestIsland(p);
  };

  const islands = graph.parts.filter(isIsland);
  const home = new Map<string, string | null>();
  for (const p of graph.parts)
    home.set(p.id, isIsland(p) ? null : (homeOf(p)?.id ?? null));
  const parentIsland = new Map<string, string | null>(
    islands.map((p) => [p.id, nearestIsland(p)?.id ?? null]),
  );
  const childIslands = new Map<string, Part[]>();
  for (const i of islands) {
    const parent = parentIsland.get(i.id);
    if (parent)
      childIslands.set(parent, [...(childIslands.get(parent) ?? []), i]);
  }
  const members = new Map<string, Part[]>();
  for (const p of graph.parts) {
    const h = home.get(p.id);
    if (h) members.set(h, [...(members.get(h) ?? []), p]);
  }

  // Island colors: the presentation's, the kind's, or the palette in order.
  const colors = new Map<string, string>();
  let paletteIndex = 0;
  for (const i of islands) {
    colors.set(
      i.id,
      presentation.parts?.[i.id]?.color ??
        look(i).color ??
        paletteColor(presentation, paletteIndex++),
    );
  }

  const parts = new Map<string, Placement>();
  const placements: IslandPlacement[] = [];
  const unplaced: Layout["unplaced"] = [];

  /** Links between two sets of parts, to put related islands near each other. */
  const linkCount = coupling(index, (id) => {
    let h: string | null | undefined = home.get(id);
    if (h === null)
      h = index.part.has(id) && isIsland(index.part.get(id)!) ? id : null;
    // Up to the top-level island.
    while (h && parentIsland.get(h)) h = parentIsland.get(h)!;
    return h ?? null;
  });

  const focus = presentation.focus;
  const containsFocus = (id: string): boolean => {
    if (!focus) return false;
    let f: string | null | undefined = focus;
    while (f) {
      if (f === id) return true;
      f = parentIsland.get(f) ?? home.get(f);
    }
    return false;
  };

  const inClientZone = (id: string) => {
    let top = id;
    while (parentIsland.get(top)) top = parentIsland.get(top)!;
    const p = index.part.get(top);
    return !!p && zoneOf(p) === "client";
  };
  /**
   * A scale per member of a district of client code, by how much of the
   * district depends on it: the members that reach it along the links
   * between members (a module every other one imports, at the heart, is
   * the largest; a helper only its own method uses, at the rim, the
   * smallest). Larger members are packed first, nearest the middle. A
   * district with no links between its members keeps its sizes.
   */
  const heart = new Map<string, number>();
  const weightOf = (n: Node) => n.weight ?? heart.get(n.id) ?? 1;
  const weigh = (own: Part[]) => {
    const ids = new Set(own.map((p) => p.id));
    const out = new Map<string, string[]>();
    for (const l of graph.links)
      if (ids.has(l.from) && ids.has(l.to) && l.from !== l.to)
        out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    const reached = new Map<string, number>();
    for (const from of ids) {
      const seen = new Set<string>([from]);
      const stack = [from];
      while (stack.length)
        for (const n of out.get(stack.pop()!) ?? [])
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
            reached.set(n, (reached.get(n) ?? 0) + 1);
          }
    }
    const most = Math.max(0, ...reached.values());
    if (!most) return;
    for (const id of ids)
      heart.set(id, 0.6 + 0.9 * Math.sqrt((reached.get(id) ?? 0) / most));
  };

  // Sizes bottom-up: each island arranges its contents around its center.
  const arranged = new Map<
    string,
    { radius: number; place: (center: Vec3) => void }
  >();
  const arrange = (
    island: Part,
    depth: number,
  ): { radius: number; place: (center: Vec3) => void } => {
    const known = arranged.get(island.id);
    if (known) return known;
    const own = members.get(island.id) ?? [];
    const ownIds = new Set(own.map((p) => p.id));
    // Within the island, a member whose parent is a member stands by it.
    const kids = new Map<string, Part[]>();
    const roots: Part[] = [];
    for (const p of own) {
      if (p.parent && ownIds.has(p.parent))
        kids.set(p.parent, [...(kids.get(p.parent) ?? []), p]);
      else roots.push(p);
    }
    if (inClientZone(island.id)) weigh(own);
    const footprint = (p: Part) =>
      FOOTPRINT[look(p).shape] * (look(p).size ?? 1) * (heart.get(p.id) ?? 1);
    // A bundle: a member and the members below it.
    const bundle = (p: Part): Node => {
      const below = (kids.get(p.id) ?? []).map(bundle);
      if (!below.length) {
        return {
          id: p.id,
          r: footprint(p),
          order: ORDER[look(p).shape],
          flow: look(p).flow,
          layoutChildren: (o) => setPart(p, o, island.id, depth),
        };
      }
      const circles = packCircles(
        [footprint(p), ...below.map((b) => b.r)],
        GAP * 0.6,
      );
      return {
        id: p.id,
        r: enclosing(circles),
        order: ORDER[look(p).shape],
        layoutChildren: (o) => {
          setPart(
            p,
            [o[0] + circles[0].x, o[1], o[2] + circles[0].z],
            island.id,
            depth,
          );
          below.forEach((b, i) =>
            b.layoutChildren!([
              o[0] + circles[i + 1].x,
              o[1],
              o[2] + circles[i + 1].z,
            ]),
          );
        },
      };
    };
    // Roots whose parent lives elsewhere group into a cluster per parent.
    const groups = new Map<string, Part[]>();
    const loose: Part[] = [];
    for (const p of roots) {
      if (p.parent && p.parent !== island.id && index.part.has(p.parent))
        groups.set(p.parent, [...(groups.get(p.parent) ?? []), p]);
      else loose.push(p);
    }
    const clusters: Cluster[] = [];
    const nodes: Node[] = [
      ...loose.map(bundle),
      ...[...groups].map(([key, list]): Node => {
        const inner = list
          .map(bundle)
          .sort((a, b) => a.order - b.order || weightOf(b) - weightOf(a));
        const circles = packCircles(
          inner.map((n) => n.r),
          GAP * 0.8,
        );
        const r = enclosing(circles) + 0.6;
        return {
          id: key,
          r,
          order: 7,
          weight: list.some((p) => heart.has(p.id))
            ? Math.max(...list.map((p) => heart.get(p.id) ?? 1))
            : undefined,
          layoutChildren: (o) => {
            clusters.push({ id: key, center: o, radius: r });
            inner.forEach((n, i) =>
              n.layoutChildren!([
                o[0] + circles[i].x,
                o[1],
                o[2] + circles[i].z,
              ]),
            );
          },
        };
      }),
      ...(childIslands.get(island.id) ?? [])
        .sort(
          (a, b) => Number(containsFocus(b.id)) - Number(containsFocus(a.id)),
        )
        .map((child): Node => {
          const sub = arrange(child, depth + 1);
          return {
            id: child.id,
            r: sub.radius,
            order: containsFocus(child.id) ? 7.5 : 8,
            flow: look(child).flow,
            layoutChildren: (o) => sub.place([o[0], o[1] + PLATEAU, o[2]]),
          };
        }),
    ].sort(
      (a, b) => a.order - b.order || weightOf(b) - weightOf(a) || b.r - a.r,
    );
    // The child island holding the focus (the app the page calls) stands
    // on the rim toward the clients, the rest behind it.
    const focal =
      !inClientZone(island.id) && nodes.length > 1
        ? nodes.findIndex(
            (n) =>
              n.flow === undefined &&
              childIslands.get(island.id)?.some((c) => c.id === n.id) &&
              containsFocus(n.id),
          )
        : -1;
    const circles =
      focal >= 0 && !nodes.some((n) => n.flow !== undefined)
        ? nearRim(
            nodes.map((n) => n.r),
            focal,
          )
        : nodes.some((n) => n.flow !== undefined)
          ? flowColumns(nodes)
          : // A district with a heart keeps it at its middle.
            packCircles(
              nodes.map((n) => n.r),
              GAP,
              Math.PI / 2,
              !nodes.some((n) => heart.has(n.id) || n.weight !== undefined),
            );
    // An island's kind can ask for more room than its contents need.
    const radius = Math.max(
      4 * (look(island).size ?? 1),
      enclosing(circles) + MARGIN,
    );
    const result = {
      radius,
      place: (center: Vec3) => {
        const placement: IslandPlacement = {
          id: island.id,
          shape: "island",
          position: center,
          radius,
          island: parentIsland.get(island.id) ?? null,
          color: colors.get(island.id)!,
          zone: zoneOf(island) ?? "platform",
          depth,
          parentIsland: parentIsland.get(island.id) ?? null,
          members: own.map((p) => p.id),
          clusters,
        };
        placements.push(placement);
        parts.set(island.id, placement);
        nodes.forEach((n, i) =>
          n.layoutChildren!([
            center[0] + circles[i].x,
            center[1],
            center[2] + circles[i].z,
          ]),
        );
      },
    };
    arranged.set(island.id, result);
    return result;
  };

  function setPart(p: Part, position: Vec3, island: string, _depth: number) {
    const l = look(p);
    const profile = l.profileBy
      ? l.profiles?.[partValues(p)[l.profileBy] as string]
      : undefined;
    parts.set(p.id, {
      id: p.id,
      shape: l.shape,
      position,
      radius: FOOTPRINT[l.shape] * (l.size ?? 1) * (heart.get(p.id) ?? 1),
      island,
      color:
        presentation.parts?.[p.id]?.color ?? l.color ?? colors.get(island)!,
      profile,
    });
  }

  // Top-level islands by zone.
  const top = islands.filter((i) => !parentIsland.get(i.id));
  const byZone = (z: Zone) =>
    top.filter((i) => (zoneOf(i) ?? "platform") === z);
  const platformIslands = byZone("platform");
  // The island holding the focus first, then by how much each relates to it.
  const anchor =
    platformIslands.find((i) => containsFocus(i.id)) ??
    [...platformIslands].sort(
      (a, b) => arrange(b, 0).radius - arrange(a, 0).radius,
    )[0];
  // With a focus, what it uses (the components its app mounts) stands
  // beside it on the clients' side, and the rest on the far side; the
  // wedge straight between the focus and the clients stays open.
  const focusLinks = focus
    ? coupling(index, (id) => {
        let h: string | null | undefined = id;
        while (h) {
          if (h === focus) return focus;
          const p = index.part.get(h);
          const up: string | null | undefined =
            p && isIsland(p) ? parentIsland.get(h) : home.get(h);
          if (!up) return p && isIsland(p) ? h : null;
          h = up;
        }
        return null;
      })
    : null;
  const usedBy = (i: Part) =>
    focusLinks && anchor && containsFocus(anchor.id)
      ? focusLinks(i.id, focus!)
      : 0;
  const ordered = anchor
    ? [
        anchor,
        ...platformIslands
          .filter((i) => i !== anchor)
          .sort(
            (a, b) =>
              Number(usedBy(b) > 0) - Number(usedBy(a) > 0) ||
              usedBy(b) - usedBy(a) ||
              linkCount(b.id, anchor.id) - linkCount(a.id, anchor.id) ||
              arrange(b, 0).radius - arrange(a, 0).radius ||
              a.id.localeCompare(b.id),
          ),
      ]
    : [];
  // From the right of the anchor: the clients wait on the left.
  const towardClients = Math.PI;
  const platformCircles = pack(
    ordered.map((i, k) => {
      const r = arrange(i, 0).radius;
      if (k === 0 || !focusLinks || !containsFocus(anchor!.id))
        return { r, start: 0 };
      return usedBy(i) > 0
        ? {
            r,
            start: towardClients,
            avoid: { angle: towardClients, half: 0.1 },
          }
        : { r, start: 0, avoid: { angle: towardClients, half: 0.9 } };
    }),
    3.5,
    true,
  );
  ordered.forEach((i, k) =>
    arrange(i, 0).place([platformCircles[k].x, 0, platformCircles[k].z]),
  );
  const platformRadius = Math.max(12, enclosing(platformCircles) + 6);
  const minX = -platformRadius;
  const maxX = platformRadius;

  // Client islands on the left, stacked front to back.
  const clients = byZone("client");
  let z = 0;
  const clientSizes = clients.map((i) => arrange(i, 0).radius);
  const clientSpan = clientSizes.reduce((s, r) => s + 2 * r + 6, -6);
  z = -clientSpan / 2;
  const clientX = minX - 14 - Math.max(0, ...clientSizes);
  clients.forEach((i, k) => {
    const r = clientSizes[k];
    arrange(i, 0).place([clientX, 3, z + r]);
    z += 2 * r + 6;
  });

  // Top-level parts that are not islands: external ones on the right, the
  // others (callers) on the platform's rim, facing the clients.
  const orphans = graph.parts.filter((p) => !isIsland(p) && !home.get(p.id));
  const external = orphans.filter(
    (p) => zoneOf(p) === "external" || look(p).shape === "beacon",
  );
  const rim = orphans.filter((p) => !external.includes(p));
  const externalIslands = byZone("external");
  const outer: { id: string; r: number; part?: Part }[] = [
    ...externalIslands.map((i) => ({ id: i.id, r: arrange(i, 0).radius })),
    ...external.map((p) => ({
      id: p.id,
      r: FOOTPRINT[look(p).shape] * (look(p).size ?? 1),
      part: p,
    })),
  ];
  const externalSpan = outer.reduce((s, o) => s + 2 * o.r + 5, -5);
  z = -externalSpan / 2;
  const externalX = maxX + 16 + Math.max(0, ...outer.map((o) => o.r));
  for (const o of outer) {
    const at: Vec3 = [externalX, 5, z + o.r];
    if (o.part) {
      setPart(o.part, at, "", 0);
      parts.get(o.id)!.island = null;
    } else arrange(index.part.get(o.id)!, 0).place(at);
    z += 2 * o.r + 5;
  }
  rim.forEach((p, k) => {
    const spread = Math.min(Math.PI * 0.7, 0.22 * rim.length);
    const a =
      Math.PI +
      (rim.length === 1 ? 0 : -spread / 2 + (spread * k) / (rim.length - 1));
    const r = platformRadius - 1.5;
    setPart(p, [r * Math.cos(a), 0, -r * Math.sin(a)], "", 0);
    parts.get(p.id)!.island = null;
  });

  for (const p of graph.parts) {
    if (!parts.has(p.id))
      unplaced.push({ id: p.id, reason: "No island, zone or rim takes it." });
  }

  // Parents before children.
  placements.sort((a, b) => a.depth - b.depth);

  const xs = [...parts.values()].flatMap((p) => [
    p.position[0] - p.radius,
    p.position[0] + p.radius,
  ]);
  const zs = [...parts.values()].flatMap((p) => [
    p.position[2] - p.radius,
    p.position[2] + p.radius,
  ]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  // Fit the bounds in a 16:9 view with a 42° vertical field of view, from
  // the front and above.
  const width = Math.max(...xs) - Math.min(...xs);
  const depth = Math.max(...zs) - Math.min(...zs);
  const distance = 1.08 * Math.max(width / 2 / 0.68, depth / 2 / 0.3);
  const direction = [0, 0.78, 0.63];
  // Home: the client region, and the near side of the platform beyond it,
  // with the island of the focus (the app its calls reach first).
  const client = presentation.client
    ? parts.get(presentation.client)
    : undefined;
  const homeView = client
    ? (() => {
        const r = client.radius;
        const target: Vec3 = [
          client.position[0] + r * 0.45,
          0,
          client.position[2],
        ];
        const d = 1.05 * ((r * 3) / 2 / 0.68);
        // The focus's island, then the islands it uses.
        const landing = [
          ...(focus ? [focus] : []),
          ...ordered
            .slice(1)
            .filter((i) => usedBy(i) > 0)
            .map((i) => i.id),
        ].flatMap((id) => {
          const q = parts.get(id);
          return q ? [{ center: q.position, radius: q.radius }] : [];
        });
        return {
          target,
          region: { center: client.position, radius: r },
          beyond: landing,
          position: [
            target[0],
            direction[1] * d,
            target[2] + direction[2] * d,
          ] as Vec3,
        };
      })()
    : undefined;
  return {
    strategy: "islands",
    home: homeView,
    parts,
    islands: placements,
    platform: { center: [0, -2.4, 0], radius: platformRadius },
    overview: {
      target: [cx, 0, cz + depth * 0.06],
      position: [
        cx + direction[0] * distance,
        direction[1] * distance,
        cz + depth * 0.06 + direction[2] * distance,
      ],
    },
    unplaced,
  };
};

/** Counts the links between the top-level islands of two parts. */
function coupling(index: GraphIndex, topOf: (id: string) => string | null) {
  const counts = new Map<string, number>();
  for (const l of index.graph.links) {
    const a = topOf(l.from);
    const b = topOf(l.to);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (a: string, b: string) =>
    counts.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
}
