/**
 * Dependencies as arcs of light. From afar, one arc per pair of related
 * top-level islands, brighter the more links join them. A selected part
 * lights who it dealt with so far in the recording, one arc each, the
 * latest brightest. With the detail asked for, it lights each of its links
 * in the source in both directions, in the color of its kind, and shows
 * each unresolved dependency as a dashed stub rising into nothing.
 * Overlays draw every link, or every unresolved stub, at once. Each layer is
 * one draw call.
 */
import { Line } from "@react-three/drei";
import { useMemo } from "react";
import { Color, QuadraticBezierCurve3, Vector3 } from "three";
import { usePlayback, world } from "../store.ts";
import { highlightOf } from "./highlight.ts";
import { callNow } from "./Running.tsx";
import { anchorPosition, linkColor, placementOf, topIsland } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";
import { Tag } from "./Tag.tsx";

const SAMPLES = 14;

/** An arc between two points, as pairs of points for a segments line. */
function arc(a: Vector3, b: Vector3, out: Vector3[], lift = 0.22) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mid.y = Math.max(a.y, b.y) + Math.min(30, 1.5 + a.distanceTo(b) * lift);
  const curve = new QuadraticBezierCurve3(a, mid, b);
  let prev = curve.getPoint(0);
  for (let i = 1; i <= SAMPLES; i++) {
    const next = curve.getPoint(i / SAMPLES);
    out.push(prev, next);
    prev = next;
  }
}

function Segments({
  points,
  colors,
  width,
  opacity = 1,
  dashed = false,
}: {
  points: Vector3[];
  colors: Color[];
  width: number;
  opacity?: number;
  dashed?: boolean;
}) {
  if (points.length < 2) return null;
  return (
    <Line
      segments
      points={points}
      vertexColors={colors}
      lineWidth={width}
      transparent
      opacity={opacity}
      depthWrite={false}
      dashed={dashed}
      dashSize={0.5}
      gapSize={0.35}
      toneMapped={false}
      raycast={() => null}
    />
  );
}

/** How bright the arcs between islands are at rest: quiet, under what acts. */
const AT_REST = 0.16;

/** The pair of top-level islands of two parts, as a key, if they differ. */
function pairOf(a: string, b: string): string | null {
  const x = topIsland(a);
  const y = topIsland(b);
  if (!x || !y || x === y) return null;
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

const relationCache = new WeakMap<
  typeof world.graph,
  Map<string, { points: Vector3[]; color: Color }>
>();

/** One arc per pair of related top-level islands, brighter the more links. */
function relations() {
  const hit = relationCache.get(world.graph);
  if (hit) return hit;
  const counts = new Map<string, number>();
  for (const l of world.graph.links) {
    const key = pairOf(l.from, l.to);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  const out = new Map<string, { points: Vector3[]; color: Color }>();
  for (const [key, n] of counts) {
    const [a, b] = key.split("|");
    const points: Vector3[] = [];
    arc(anchorPosition(a), anchorPosition(b), points, 0.16);
    const k = 0.25 + 0.9 * Math.sqrt(n / max);
    out.set(key, { points, color: new Color("#8fa6ff").multiplyScalar(k) });
  }
  relationCache.set(world.graph, out);
  return out;
}

/**
 * The arcs between islands, quiet at rest. While an asked call runs in
 * another top-level island than the one it entered the backend on, an arc
 * from the island it entered on to the island it is in now (both from the
 * run's activations) shows clearly; the others stay quiet.
 */
function Relations() {
  const all = useMemo(() => {
    const points: Vector3[] = [];
    const colors: Color[] = [];
    for (const r of relations().values()) {
      points.push(...r.points);
      for (let i = 0; i < r.points.length; i++) colors.push(r.color);
    }
    return { points, colors };
  }, []);
  const version = usePlayback((s) => s.version);
  // The islands the call entered on and is on now: their own islands, not
  // the top-level ones, so the arc ends where the halos are.
  const acting = usePlayback((s) => {
    void version;
    const c = callNow(world.timeline, s.time);
    if (!c) return null;
    const from = placementOf(c.entry)?.island;
    const to = placementOf(c.now)?.island;
    return from && to && from !== to && pairOf(c.entry, c.now)
      ? `${from}|${to}`
      : null;
  });
  const lit = useMemo(() => {
    if (!acting) return null;
    const [a, b] = acting.split("|");
    const points: Vector3[] = [];
    arc(anchorPosition(a), anchorPosition(b), points, 0.16);
    const color = new Color("#c9d4ff").multiplyScalar(1.4);
    return { points, colors: points.map(() => color) };
  }, [acting]);
  return (
    <>
      <Segments
        points={all.points}
        colors={all.colors}
        width={1.2}
        opacity={AT_REST}
      />
      {lit && (
        <Segments
          points={lit.points}
          colors={lit.colors}
          width={2.4}
          opacity={0.9}
        />
      )}
    </>
  );
}

function linkArcs(links: typeof world.graph.links) {
  const points: Vector3[] = [];
  const colors: Color[] = [];
  for (const l of links) {
    const before = points.length;
    arc(anchorPosition(l.from), anchorPosition(l.to), points);
    const color = new Color(linkColor(l.kind)).multiplyScalar(1.6);
    for (let i = before; i < points.length; i++) colors.push(color);
  }
  return { points, colors };
}

function stubs(ids: string[]) {
  const points: Vector3[] = [];
  const colors: Color[] = [];
  const color = new Color(TONE_COLORS.error).multiplyScalar(1.6);
  for (const id of ids) {
    const a = anchorPosition(id);
    points.push(a, a.clone().setY(a.y + 7));
    colors.push(color, color.clone().multiplyScalar(0.2));
  }
  return { points, colors };
}

function AllLinks() {
  const { points, colors } = useMemo(() => linkArcs(world.graph.links), []);
  return <Segments points={points} colors={colors} width={1} opacity={0.35} />;
}

function AllUnresolved() {
  const { points, colors } = useMemo(
    () => stubs([...new Set(world.graph.unresolved.flatMap((u) => u.from))]),
    [],
  );
  return <Segments points={points} colors={colors} width={1.6} dashed />;
}

/**
 * An island's links, one arc per island (or part) at the other end, in the
 * color of the most common kind, wider the more links it stands for.
 */
function islandArcs(h: ReturnType<typeof highlightOf>) {
  const groups = new Map<string, Map<string, number>>();
  for (const l of h.links) {
    const other = h.covered.has(l.from) ? l.to : l.from;
    const end = topIsland(other) ?? other;
    const kinds = groups.get(end) ?? new Map<string, number>();
    kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
    groups.set(end, kinds);
  }
  const points: Vector3[] = [];
  const colors: Color[] = [];
  const from = anchorPosition(h.part!);
  for (const [end, kinds] of groups) {
    const [kind] = [...kinds].sort((a, b) => b[1] - a[1])[0];
    const n = [...kinds.values()].reduce((a, b) => a + b, 0);
    const before = points.length;
    arc(from, anchorPosition(end), points, 0.16);
    const color = new Color(linkColor(kind)).multiplyScalar(
      0.8 + Math.min(2, Math.sqrt(n) * 0.35),
    );
    for (let i = before; i < points.length; i++) colors.push(color);
  }
  return { points, colors };
}

/** How a recorded contact is drawn: warm white, fading with age. */
const CONTACT = new Color("#ffe9c2");

/**
 * The parts the selection dealt with by now, as the recording shows: one
 * arc from the covered part that dealt to each other part, brighter the
 * more recent. Nothing else: a part that dealt with no one has no arc.
 */
function ContactLinks() {
  const selected = usePlayback((s) => s.selected);
  const time = usePlayback((s) => s.time);
  const version = usePlayback((s) => s.version);
  const h = highlightOf(selected);
  const key = h.contacts.map((c) => `${c.from}>${c.other}:${c.n}`).join();
  const arcs = useMemo(() => {
    void version;
    const points: Vector3[] = [];
    const colors: Color[] = [];
    for (const c of h.contacts) {
      if (!placementOf(c.from) || !placementOf(c.other)) continue;
      const before = points.length;
      arc(anchorPosition(c.from), anchorPosition(c.other), points, 0.16);
      const age = Math.max(0, time - c.last);
      const color = CONTACT.clone().multiplyScalar(0.55 + 1.2 / (1 + age / 6));
      for (let i = before; i < points.length; i++) colors.push(color);
    }
    return { points, colors };
    // Redrawn when who dealt with whom changes, and as the latest one ages.
  }, [key, Math.floor(time), version]);
  return <Segments points={arcs.points} colors={arcs.colors} width={2.2} />;
}

function SelectionLinks() {
  const selected = usePlayback((s) => s.selected);
  const h = highlightOf(selected);
  const links = useMemo(
    () => (h.island ? islandArcs(h) : linkArcs(h.links)),
    [h],
  );
  // Stubs rise from the parts the unresolved sites belong to (from the island, for an island).
  const from = useMemo(
    () =>
      h.island
        ? h.unresolved.length
          ? [h.part!]
          : []
        : [
            ...new Set(
              h.unresolved.flatMap((u) =>
                u.from.filter((f) => h.covered.has(f)),
              ),
            ),
          ],
    [h],
  );
  const loose = useMemo(() => stubs(from), [from]);
  return (
    <>
      <Segments
        points={links.points}
        colors={links.colors}
        width={h.island ? 3 : 2.4}
      />
      <Segments points={loose.points} colors={loose.colors} width={2} dashed />
      {from.map((id) => {
        const a = anchorPosition(id);
        const n = h.island
          ? h.unresolved.length
          : h.unresolved.filter((u) => u.from.includes(id)).length;
        return (
          <Tag
            key={id}
            position={[a.x, a.y + 7.6, a.z]}
            color={TONE_COLORS.error}
          >
            {`? ${n} unresolved`}
          </Tag>
        );
      })}
    </>
  );
}

export function Links() {
  const overlays = usePlayback((s) => s.overlays);
  const anySelected = usePlayback((s) => s.selected !== null);
  const detail = usePlayback((s) => s.detail);
  return (
    <>
      {overlays.relations && !anySelected && !overlays.links && <Relations />}
      {overlays.links && <AllLinks />}
      {overlays.unresolved && <AllUnresolved />}
      {anySelected && (detail ? <SelectionLinks /> : <ContactLinks />)}
    </>
  );
}
