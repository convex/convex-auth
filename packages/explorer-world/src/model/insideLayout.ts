/**
 * Where the inside of a part is drawn when it opens up: on a disc of its
 * own, in metres from the disc's centre. A pure function of the inside, so
 * that it is the same for every viewer and can be tested.
 *
 * - The main export (the one class, else the only export that does
 *   something) stands in the middle, its members on a ring around it.
 * - The other exports that do something stand on a ring further out; the
 *   ones that only name a type sit on the rim, small.
 * - An export that is a part of its own (a hook) is not drawn again: it
 *   stands beside the module already.
 * - What the part holds sits on an arc at the front: its stored keys (a
 *   lock rings the key it is named after), then its state.
 * - Each place in its code that reports a step is a mark on the place it
 *   sits in, in a small ring; marks of code it does not export sit on the
 *   disc's own rim.
 */
import type { PartInside, Place } from "./inside.ts";

export type InsideShape =
  "class" | "function" | "member" | "value" | "type" | "reexport";

export interface LaidPlace {
  place: Place;
  x: number;
  z: number;
  shape: InsideShape;
  /** The radius of the ring its step marks stand on. */
  ring: number;
}

export interface LaidHolding {
  kind: "key" | "lock" | "state";
  name: string;
  x: number;
  z: number;
}

export interface LaidSite {
  id: string;
  step: string;
  /** The place it sits on, or `null` on the rim. */
  place: string | null;
  x: number;
  z: number;
}

export interface InsideLayout {
  radius: number;
  places: LaidPlace[];
  holds: LaidHolding[];
  sites: LaidSite[];
}

const shapeOf = (p: Place): InsideShape =>
  p.from
    ? "reexport"
    : p.typeOnly
      ? "type"
      : p.of
        ? "member"
        : p.kind === "class"
          ? "class"
          : p.kind === "function" || p.kind === "default"
            ? "function"
            : "value";

const around = (n: number, r: number, start = -Math.PI / 2) =>
  Array.from({ length: n }, (_, i) => {
    const a = start + (i / Math.max(1, n)) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r] as const;
  });

export function layInside(inside: PartInside): InsideLayout {
  const shown = inside.places.filter((p) => !p.part && p.kind !== "all");
  const tops = shown.filter((p) => !p.of);
  const runtime = tops.filter((p) => !p.typeOnly && !p.from);
  const classes = runtime.filter((p) => p.kind === "class");
  const main =
    classes.length === 1
      ? classes[0]
      : runtime.length === 1
        ? runtime[0]
        : null;
  const members = main ? shown.filter((p) => p.of === main.id) : [];
  const others = runtime.filter((p) => p !== main);
  const rim = tops.filter((p) => p.typeOnly || p.from);

  const inner = main
    ? members.length
      ? Math.max(1.1, 0.4 + members.length * 0.11)
      : 0
    : 0;
  const middle = Math.max(
    inner + 0.9,
    main ? 0 : 0.35 + others.length * 0.16,
    0.8,
  );
  const radius =
    !main && others.length <= 1 ? 0.7 : Math.max(1.2, middle + 0.7);
  const places: LaidPlace[] = [];
  if (main)
    places.push({ place: main, x: 0, z: 0, shape: shapeOf(main), ring: 0.42 });
  around(members.length, inner).forEach(([x, z], i) =>
    places.push({ place: members[i], x, z, shape: "member", ring: 0.2 }),
  );
  // Others on the middle ring; with no main export, a single one in the middle.
  if (!main && others.length === 1)
    places.push({
      place: others[0],
      x: 0,
      z: 0,
      shape: shapeOf(others[0]),
      ring: 0.3,
    });
  else
    around(
      others.length,
      main ? middle : middle * 0.7,
      -Math.PI / 2 + 0.3,
    ).forEach(([x, z], i) =>
      places.push({
        place: others[i],
        x,
        z,
        shape: shapeOf(others[i]),
        ring: 0.26,
      }),
    );
  // Types and re-exports on the back of the rim.
  rim.forEach((p, i) => {
    const a = -Math.PI + (Math.PI * (i + 1)) / (rim.length + 1);
    places.push({
      place: p,
      x: Math.cos(a) * (radius - 0.25),
      z: Math.sin(a) * (radius - 0.25),
      shape: shapeOf(p),
      ring: 0.14,
    });
  });

  // What it holds: an arc at the front, keys first.
  const holdList = [
    ...inside.holds.filter((h) => h.kind === "key"),
    ...inside.holds.filter((h) => h.kind === "state"),
  ];
  const holds: LaidHolding[] = [];
  const span = Math.min(Math.PI * 0.8, holdList.length * 0.16);
  holdList.forEach((h, i) => {
    const a =
      Math.PI / 2 +
      (holdList.length > 1 ? (i / (holdList.length - 1) - 0.5) * span : 0);
    holds.push({
      kind: h.kind,
      name: h.name,
      x: Math.cos(a) * (radius + 0.35),
      z: Math.sin(a) * (radius + 0.35),
    });
  });
  for (const l of inside.holds.filter((h) => h.kind === "lock")) {
    const key = holds.find((h) => h.kind === "key" && h.name === l.detail);
    holds.push({
      kind: "lock",
      name: l.name,
      x: key?.x ?? 0,
      z: key?.z ?? radius + 0.35,
    });
  }

  // Step marks: a small ring on each place, in the order of the source.
  const at = new Map(places.map((p) => [p.place.id, p]));
  const byPlace = new Map<string | null, typeof inside.sites>();
  for (const s of inside.sites) {
    const key = s.place && at.has(s.place) ? s.place : null;
    byPlace.set(key, [...(byPlace.get(key) ?? []), s]);
  }
  const sites: LaidSite[] = [];
  for (const [key, list] of byPlace) {
    const p = key ? at.get(key)! : null;
    const ordered = [...list].sort((a, b) => a.line - b.line);
    if (p) {
      around(ordered.length, p.ring).forEach(([dx, dz], i) =>
        sites.push({
          id: ordered[i].id,
          step: ordered[i].step,
          place: key,
          x: p.x + dx,
          z: p.z + dz,
        }),
      );
    } else {
      around(ordered.length, radius - 0.08).forEach(([x, z], i) =>
        sites.push({
          id: ordered[i].id,
          step: ordered[i].step,
          place: null,
          x,
          z,
        }),
      );
    }
  }
  return { radius, places, holds, sites };
}
