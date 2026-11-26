/**
 * Dependencies as arcs of light. From afar, one arc per pair of related
 * top-level islands, brighter the more links join them. A selected part
 * lights each of its links in both directions, in the color of its kind,
 * and shows each unresolved dependency as a dashed stub rising into nothing.
 * Overlays draw every link, or every unresolved stub, at once. Each layer is
 * one draw call.
 */
import { Line } from "@react-three/drei";
import { useMemo } from "react";
import { Color, QuadraticBezierCurve3, Vector3 } from "three";
import { usePlayback, world } from "../store.ts";
import { highlightOf } from "./highlight.ts";
import { anchorPosition, linkColor, topIsland } from "./look.ts";
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

/** One arc per pair of related top-level islands. */
function Relations() {
  const { points, colors } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of world.graph.links) {
      const a = topIsland(l.from);
      const b = topIsland(l.to);
      if (!a || !b || a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const points: Vector3[] = [];
    const colors: Color[] = [];
    const max = Math.max(1, ...counts.values());
    for (const [key, n] of counts) {
      const [a, b] = key.split("|");
      const before = points.length;
      arc(anchorPosition(a), anchorPosition(b), points, 0.16);
      const k = 0.25 + 0.9 * Math.sqrt(n / max);
      const color = new Color("#8fa6ff").multiplyScalar(k);
      for (let i = before; i < points.length; i++) colors.push(color);
    }
    return { points, colors };
  }, []);
  return (
    <Segments points={points} colors={colors} width={1.4} opacity={0.55} />
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
  return (
    <>
      {overlays.relations && !anySelected && !overlays.links && <Relations />}
      {overlays.links && <AllLinks />}
      {overlays.unresolved && <AllUnresolved />}
      <SelectionLinks />
    </>
  );
}
