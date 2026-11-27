/**
 * Where the places of the stage are, in the world: an element on the page,
 * a module of the client code, a key of localStorage, the mouth of a
 * channel, an exit. The floor, the activity and the paths all draw from
 * here, so a traveller arrives exactly at the thing it goes to.
 *
 * @module
 */
import {
  CHANNELS,
  CLIENT,
  EXIT_Z,
  EXITS,
  LOCAL,
  PAGE,
  extraExit,
  grid,
  type Spot,
  type Vec3,
} from "./layout.ts";
import type { Exit, StageModel } from "./model.ts";
import type { Place } from "./paths.ts";
import type { ClientPart } from "./sources.ts";

/** The height of a module's top, above its district's. */
export const MODULE_H = 1.6;
/** The height of a key object. */
export const KEY_H = 2.2;

/** The spot of the element tile `order` of `n`, on the page. */
export function elementSpot(order: number, n: number): Spot {
  const inner: Spot = { ...PAGE, w: PAGE.w * 0.8 };
  const span = inner.w / Math.max(n, 6);
  return {
    x: inner.x - inner.w / 2 + (order + 0.5) * span,
    z: PAGE.z - 2,
    w: span * 0.8,
    d: 12,
    h: PAGE.h,
  };
}

/** The spot of module `i` of `n` in the client district `spot`. */
export function moduleSpot(spot: Spot, i: number, n: number): Spot {
  const g = grid(spot, n);
  const { x, z } = g.at(i);
  return { x, z, w: g.cw * 0.86, d: g.rd * 0.8, h: MODULE_H };
}

/** The grid of the keys of localStorage and sessionStorage. */
export function keyGrid(model: StageModel) {
  return grid(LOCAL, Math.max(model.local.length + model.session.length, 4), {
    aspect: 2.4,
  });
}

/** Where an exit stands across. */
export function exitX(exits: Exit[], id: string): number {
  const fixed = EXITS[id];
  if (fixed) return fixed.x;
  const extra = exits.filter((e) => !(e.id in EXITS));
  return extraExit(
    Math.max(
      0,
      extra.findIndex((e) => e.id === id),
    ),
  ).x;
}

/**
 * A point along a channel and on to its exit, `along` from 0 (the mouth,
 * at the client code) to 1 (the exit), in the lane `lane` metres to the
 * side of its middle.
 */
export function channelPoint(
  via: "socket" | "http",
  exit: number,
  along: number,
  lane: number,
): [number, number] {
  const ch = CHANNELS[via];
  const a: [number, number] = [ch.x + lane, ch.from];
  const b: [number, number] = [ch.x + lane, ch.to];
  const c: [number, number] = [exit + lane, EXIT_Z - 4];
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  let dd = along * (l1 + l2);
  if (dd <= l1)
    return [a[0] + ((b[0] - a[0]) * dd) / l1, a[1] + ((b[1] - a[1]) * dd) / l1];
  dd -= l1;
  return [
    b[0] + ((c[0] - b[0]) * dd) / Math.max(l2, 1e-6),
    b[1] + ((c[1] - b[1]) * dd) / Math.max(l2, 1e-6),
  ];
}

/** What a place needs to be found: the model and the client modules. */
export type PlaceContext = {
  model: StageModel;
  clientParts: ClientPart[];
  /** The client district that holds the structure map's modules. */
  clientMap: number;
};

/** The top of a place: where a traveller arrives at it. */
export function placePoint(place: Place, ctx: PlaceContext): Vec3 {
  const { model } = ctx;
  switch (place.type) {
    case "element": {
      const el = model.elements.find((e) => e.key === place.key);
      const s = elementSpot(el?.order ?? 0, model.elements.length);
      return [s.x, s.h + 3, s.z];
    }
    case "part": {
      const spot = CLIENT[ctx.clientMap] ?? CLIENT[1];
      const i = ctx.clientParts.findIndex((p) => p.id === place.id);
      if (i < 0) return [spot.x, spot.h, spot.z];
      const s = moduleSpot(spot, i, ctx.clientParts.length);
      return [s.x, spot.h + s.h, s.z];
    }
    case "key": {
      const local = model.local.find((s) => s.key === place.key);
      const session = model.session.find((s) => s.key === place.key);
      const i = local
        ? local.order
        : session
          ? model.local.length + session.order
          : 0;
      const p = keyGrid(model).at(i);
      return [p.x, LOCAL.h + KEY_H, p.z];
    }
    case "gate": {
      const ch = CHANNELS[place.via];
      return [ch.x, 1, ch.from];
    }
    case "exit": {
      return [exitX(model.exits, place.id), 1, EXIT_Z - 4];
    }
  }
}
