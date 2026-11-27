/** Colors, sizes and anchor points of placed parts, from the layout and the presentation. */
import { Vector3 } from "three";
import { FOOTPRINT } from "../layout/islands.ts";
import type { Placement } from "../layout/types.ts";
import { kindLook, linkLook, nounOf } from "../presentation.ts";
import type { Shape } from "../presentation.ts";
import { world } from "../store.ts";

/** How tall each shape stands, for anchors and labels. */
export const HEIGHT: Record<Shape, number> = {
  island: 0,
  pillar: 2.2,
  vault: 0.6,
  obelisk: 3.2,
  gate: 2.2,
  post: 1.5,
  shard: 2.2,
  beacon: 8,
  marker: 1,
  state: 1.2,
};

export const placementOf = (id: string): Placement | undefined =>
  world.layout.parts.get(id);

export const partOf = (id: string) => world.index.part.get(id);

export const colorOf = (id: string): string =>
  placementOf(id)?.color ?? "#9aa7c7";

export const kindOf = (id: string) =>
  kindLook(world.presentation, partOf(id)?.kind ?? "");

export const linkColor = (kind: string) =>
  linkLook(world.presentation, kind).color;

export const nounOfPart = (id: string) =>
  nounOf(world.presentation, partOf(id)?.kind ?? "");

/** The point a traveller leaves from or arrives at, above a part. */
export function anchorPosition(id: string, out = new Vector3()): Vector3 {
  const p = placementOf(id);
  if (!p) return out.set(0, 0, 0);
  out.set(...p.position);
  if (p.shape === "island") out.y += 3;
  else out.y += HEIGHT[p.shape] * (p.radius / FOOTPRINT[p.shape]) + 0.6;
  return out;
}

/** The first island up the chain of islands of a part, itself included. */
export function topIsland(id: string): string | null {
  let p = placementOf(id);
  let island: string | null = p?.shape === "island" ? id : (p?.island ?? null);
  const seen = new Set<string>();
  while (island && !seen.has(island)) {
    seen.add(island);
    p = placementOf(island);
    const parent =
      p && "parentIsland" in p ? (p.parentIsland as string | null) : null;
    if (!parent) return island;
    island = parent;
  }
  return island;
}

/** The parts a selection covers: a part, and for an island all that stands on it. */
export function coverage(id: string): Set<string> {
  const ids = new Set([id]);
  const island = world.layout.islands.find((i) => i.id === id);
  if (!island) return ids;
  const stack = [island];
  while (stack.length) {
    const i = stack.pop()!;
    for (const m of i.members) ids.add(m);
    for (const child of world.layout.islands)
      if (child.parentIsland === i.id && !ids.has(child.id)) {
        ids.add(child.id);
        stack.push(child);
      }
  }
  return ids;
}
