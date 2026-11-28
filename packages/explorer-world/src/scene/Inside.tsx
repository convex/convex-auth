/**
 * A part opened up. Close in on a module and its inside rises above it, on
 * a disc of its own (`model/insideLayout.ts`): what it exports (the members
 * of its main export around it), what it holds (its stored keys, the lock
 * on one, its state), and, around each export or member, a ring with one
 * segment for each place in its code that reports a step. A segment is
 * warm once running code reported that step, and flashes as it does; the
 * others stay slate. A place that reported is warm too, and under its name
 * stand the names of the steps it reported. Only one part is open at a
 * time: the selected one from nearer than OPEN_SELECTED, else the nearest
 * within OPEN_NEAR. While it is open, only its inside is named over its
 * disc (`openDisc` in `Labels.tsx`). A pointer on a place shows its own
 * line from the source; on a segment, the step's name.
 */
import { Billboard } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  Color,
  type Mesh,
  type MeshBasicMaterial,
  Vector3,
} from "three";
import { doneBy } from "../model/done.ts";
import {
  insideNames,
  layInside,
  OPEN_UP_DISTANCE,
  type InsideLayout,
  type InsideName,
  type LaidPlace,
} from "../model/insideLayout.ts";
import { done, insideOf } from "../insides.ts";
import { hoverFrom, hoverGone } from "../hover.ts";
import { currentState, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { KeepSize, Label } from "./Label.tsx";
import { openDisc, useDeclutter } from "./Labels.tsx";
import { anchorPosition, placementOf } from "./look.ts";

/** A selected part opens from this near (m); a part not selected from this near. */
export const OPEN_SELECTED = 16;
export const OPEN_NEAR = 8;
/** How high the disc floats over the top of the part (m). */
const LIFT = 1.1;
/** How long a segment flashes after its step was reported (s of shown time). */
const FLASH = 1.4;
/** The size of the names of the steps a place reported (m). */
const STEP_SIZE = 0.058;
/** The margin of the disc around what it holds (m). */
const MARGIN = 0.6;

const LIT = new Color("#ffcf6a");
const DARK = new Color("#46507a");

/** The parts that have an inside to open: some place to show. */
function openable(): string[] {
  return [...world.layout.parts.keys()].filter((id) => {
    const inside = insideOf(id);
    return inside && layInside(inside).places.length > 0;
  });
}

/** The centre of a part's disc. */
export function discCentre(id: string, out = new Vector3()): Vector3 {
  anchorPosition(id, out);
  // The anchor is 0.6 over the top of the part.
  out.y += LIFT - 0.6;
  return out;
}

/** The radius of a part's disc (m). */
export function discRadius(id: string): number {
  const inside = insideOf(id);
  return inside ? layInside(inside).radius + MARGIN : 0;
}

/** The sites of a part reported by shown time `t`: sure ones at 1, one of several at 0.5. */
function litAt(part: string, t: number): Map<string, number> {
  const level = new Map<string, number>();
  for (const h of doneBy(done(), part, t).hits)
    for (const site of h.sites)
      level.set(
        site,
        Math.max(level.get(site) ?? 0, h.sites.length === 1 ? 1 : 0.5),
      );
  return level;
}

const centre = new Vector3();
const look = new Vector3();

export function Inside() {
  const ids = useMemo(openable, []);
  const [open, setOpen] = useState<string | null>(null);
  const last = useRef(-1);
  const controls = useThree((s) => s.controls) as unknown as {
    setLookAt?: (
      ...a: [number, number, number, number, number, number, boolean]
    ) => void;
    getTarget?: (out: Vector3, end?: boolean) => Vector3;
  } | null;
  const camera = useThree((s) => s.camera);
  // For scripted checks: which part is open.
  (globalThis as { explorerInside?: unknown }).explorerInside = () => open;

  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current < 0.15) return;
    last.current = clock.elapsedTime;
    const sel = usePlayback.getState().selected;
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of ids) {
      const d = camera.position.distanceTo(discCentre(id, centre));
      const chosen = sel?.type === "part" && sel.id === id;
      // The selected part wins while it is in reach.
      if (d <= (chosen ? OPEN_SELECTED : OPEN_NEAR) && (chosen || d < bestD)) {
        best = id;
        if (chosen) break;
        bestD = d;
      }
    }
    // Framed: open, and the camera is close and looking at it.
    let framed: string | null = null;
    if (best) {
      discCentre(best, centre);
      controls?.getTarget?.(look, false);
      const off = Math.hypot(look.x - centre.x, look.z - centre.z);
      if (
        camera.position.distanceTo(centre) <= OPEN_UP_DISTANCE * 1.4 &&
        off <= discRadius(best)
      )
        framed = best;
      openDisc.on = true;
      openDisc.x = centre.x;
      openDisc.y = centre.y;
      openDisc.z = centre.z;
      openDisc.r = discRadius(best);
    } else openDisc.on = false;
    const s = usePlayback.getState();
    if (best !== open) setOpen(best);
    if (best !== s.open || framed !== s.framed)
      usePlayback.setState({ open: best, framed });
  });
  useEffect(() => () => void (openDisc.on = false), []);

  // "Open up" on the card: go close, the viewer asked.
  const opening = usePlayback((s) => s.opening);
  useEffect(() => {
    if (!opening || !controls?.setLookAt) return;
    const at = discCentre(opening.id);
    const away = camera.position.clone().sub(at);
    away.y = 0;
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
    away.normalize().multiplyScalar(5.2);
    controls.setLookAt(
      at.x + away.x,
      at.y + 6.4,
      at.z + away.z,
      at.x,
      at.y,
      at.z,
      true,
    );
    // Only a new request flies.
  }, [opening?.seq]);

  return open ? <OpenPart key={open} id={open} /> : null;
}

/** Who sets the hover lines of a part's disc. */
const hoverKey = (part: string) => `inside:${part}`;

function OpenPart({ id }: { id: string }) {
  const inside = insideOf(id)!;
  // It can close under the pointer, which then gets no pointerout: the line
  // of the place it was on goes with it.
  useEffect(() => () => hoverGone(hoverKey(id)), [id]);
  const lay = useMemo(() => layInside(inside), [inside]);
  const color = placementOf(id)?.color ?? "#9fc4ff";
  const at = useMemo(() => discCentre(id), [id]);
  const top = useMemo(
    () => anchorPosition(id).setY(anchorPosition(id).y - 0.6),
    [id],
  );
  // What has been reported, as it changes.
  const [lit, setLit] = useState<Map<string, number>>(() =>
    litAt(id, currentState().time),
  );
  const key = useRef("");
  useFrame(() => {
    const now = litAt(id, currentState().time);
    const k = [...now].map(([s, v]) => `${s}${v}`).join();
    if (k !== key.current) {
      key.current = k;
      setLit(now);
    }
  });
  const names = useMemo(
    () => insideNames(lay, new Set([...lit.keys()])),
    [lay, lit],
  );
  const reported = useMemo(() => {
    const out = new Set<string>();
    for (const s of lay.sites) if (s.place && lit.has(s.id)) out.add(s.place);
    return out;
  }, [lay, lit]);
  // For scripted checks: each mark, whether it is lit, and the names shown.
  (globalThis as { explorerMarks?: unknown }).explorerMarks = () =>
    lay.sites.map((s) => ({
      step: s.step,
      place: s.place,
      lit: lit.has(s.id),
    }));
  return (
    <group position={at}>
      {/* The stem from the part to its disc, and the disc. */}
      <mesh position={[0, (top.y - at.y) / 2, 0]} raycast={() => null}>
        <cylinderGeometry args={[0.025, 0.025, at.y - top.y, 6]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.5}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} raycast={() => null}>
        <circleGeometry args={[lay.radius + MARGIN, 64]} />
        <meshBasicMaterial
          color={new Color(color).multiplyScalar(0.12)}
          transparent
          opacity={0.96}
          // Drawn over what is under it; a name that hangs below its
          // surface is not cut by it.
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.004} raycast={() => null}>
        <ringGeometry
          args={[lay.radius + MARGIN - 0.04, lay.radius + MARGIN, 96]}
        />
        <meshBasicMaterial
          color={new Color(color).multiplyScalar(1.1)}
          toneMapped={false}
        />
      </mesh>
      {lay.places.map((p) => (
        <PlaceShape
          key={p.place.id}
          part={id}
          laid={p}
          color={color}
          reported={reported.has(p.place.id)}
          names={names.filter((n) => n.place === p.place.id)}
        />
      ))}
      {lay.holds.map((h, i) => (
        <HoldShape
          key={`${h.kind}:${h.name}:${i}`}
          part={id}
          hold={h}
          name={names.find((n) => n.key === `hold:${h.kind}:${h.name}`)}
        />
      ))}
      <Marks part={id} lay={lay} lit={lit} />
    </group>
  );
}

const SIZE: Record<LaidPlace["shape"], number> = {
  class: 0.4,
  function: 0.14,
  member: 0.11,
  value: 0.12,
  type: 0.05,
  reexport: 0.06,
};

function PlaceShape({
  part,
  laid,
  color,
  reported,
  names,
}: {
  part: string;
  laid: LaidPlace;
  color: string;
  reported: boolean;
  names: InsideName[];
}) {
  const { place, shape } = laid;
  const r = SIZE[shape];
  const quiet = shape === "type" || shape === "reexport";
  const tint = reported
    ? new Color(color).lerp(LIT, 0.65).multiplyScalar(1.3)
    : new Color(color).multiplyScalar(quiet ? 0.4 : 0.75);
  const handlers = {
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      hoverFrom(
        hoverKey(part),
        `${place.of ? `${place.of}.` : ""}${place.name} · ${place.kind}${
          place.summary ? ` — ${place.summary}` : ""
        }`,
      );
    },
    onPointerOut: () => hoverGone(hoverKey(part)),
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (isDrag(e)) return;
      usePlayback.getState().select({ type: "part", id: part });
    },
  };
  const h = shape === "class" ? 0.08 : shape === "value" ? 0.05 : r * 1.6;
  const own = names.find((n) => n.kind !== "steps");
  const steps = names.find((n) => n.kind === "steps");
  const size = shape === "member" ? 0.085 : shape === "class" ? 0.17 : 0.11;
  return (
    <group position={[laid.x, 0, laid.z]}>
      <mesh position-y={h / 2} {...handlers}>
        {shape === "value" ? (
          <boxGeometry args={[r * 1.6, h, r * 1.6]} />
        ) : (
          <cylinderGeometry
            args={[r, r, h, shape === "class" ? 6 : shape === "type" ? 8 : 14]}
          />
        )}
        <meshBasicMaterial color={tint} toneMapped={false} />
      </mesh>
      {own && (
        <PlaceName
          name={`${part}|${own.key}`}
          entry={own}
          y={h + (shape === "class" ? 0.24 : 0.17)}
          size={size}
          color={reported ? "#fff1cf" : "#ffffff"}
        />
      )}
      {steps && (
        <PlaceName
          name={`${part}|${steps.key}`}
          entry={steps}
          // It hangs from its top line, toward the viewer from the place.
          y={h + 0.06}
          top
          z={laid.ring + 0.12}
          size={STEP_SIZE}
          color="#ffd98a"
        />
      )}
    </group>
  );
}

function PlaceName({
  name,
  entry,
  y,
  z = 0,
  size,
  color,
  top = false,
}: {
  name: string;
  entry: InsideName;
  y: number;
  z?: number;
  /** Hang from its top line rather than stand on its middle. */
  top?: boolean;
  size: number;
  color: string;
}) {
  const group = useDeclutter(`inside:${name}`, {
    chars: Math.max(...entry.text.split("\n").map((l) => l.length)),
    lines: entry.text.split("\n").length,
    size,
    grow: { distance: 5, max: 1.8 },
    priority: entry.priority,
    hideFar: entry.far,
    over: true,
  });
  return (
    <group ref={group} position={[0, y, z]}>
      <KeepSize distance={5} max={1.8}>
        <Billboard>
          <Label
            fontSize={size}
            color={color}
            outlineWidth={size * 0.1}
            outlineColor="#03050a"
            weight={size >= 0.15 ? "bold" : "regular"}
            anchorY={top ? "top" : "middle"}
          >
            {entry.text}
          </Label>
        </Billboard>
      </KeepSize>
    </group>
  );
}

function HoldShape({
  part,
  hold,
  name,
}: {
  part: string;
  hold: InsideLayout["holds"][number];
  name?: InsideName;
}) {
  const handlers = {
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      hoverFrom(
        hoverKey(part),
        hold.kind === "key"
          ? `${hold.name} · a key it stores`
          : hold.kind === "lock"
            ? `a lock named after ${hold.name}`
            : `${hold.name} · state it keeps`,
      );
    },
    onPointerOut: () => hoverGone(hoverKey(part)),
  };
  if (hold.kind === "lock")
    return (
      <mesh
        position={[hold.x, 0.09, hold.z]}
        rotation-x={-Math.PI / 2}
        {...handlers}
      >
        <torusGeometry args={[0.17, 0.018, 8, 32]} />
        <meshBasicMaterial color="#ffb86b" toneMapped={false} />
      </mesh>
    );
  const key = hold.kind === "key";
  return (
    <group position={[hold.x, 0, hold.z]}>
      <mesh position-y={key ? 0.07 : 0.02} {...handlers}>
        <boxGeometry args={key ? [0.16, 0.14, 0.1] : [0.05, 0.04, 0.05]} />
        <meshBasicMaterial
          color={key ? "#9fe8d8" : "#5a6386"}
          toneMapped={false}
        />
      </mesh>
      {name && (
        <PlaceName
          name={`${part}|${name.key}`}
          entry={name}
          y={key ? 0.26 : 0.1}
          size={key ? 0.075 : 0.05}
          color={key ? "#c9fff2" : "#aab6d8"}
        />
      )}
    </group>
  );
}

/**
 * One arc segment per site on the ring around its place: warm once
 * reported (half-warm for a step that may be one of several), slate before,
 * flashing as it is reported while playing.
 */
function Marks({
  part,
  lay,
  lit,
}: {
  part: string;
  lay: InsideLayout;
  lit: Map<string, number>;
}) {
  const glow = useRef<(Mesh | null)[]>([]);
  // Each site's ring, centre, angle and the arc it takes.
  const arcs = useMemo(() => {
    const at = new Map(lay.places.map((p) => [p.place.id, p]));
    const count = new Map<string | null, number>();
    for (const s of lay.sites)
      count.set(s.place, (count.get(s.place) ?? 0) + 1);
    return lay.sites.map((s) => {
      const p = s.place ? at.get(s.place) : undefined;
      const cx = p?.x ?? 0;
      const cz = p?.z ?? 0;
      const radius = p ? p.ring : lay.radius + MARGIN * 0.45;
      const n = count.get(s.place) ?? 1;
      const angle = Math.atan2(s.z - cz, s.x - cx);
      const span = ((Math.PI * 2) / n) * (n === 1 ? 0.5 : 0.72);
      return { s, cx, cz, radius, angle, span };
    });
  }, [lay]);
  useFrame(() => {
    const { time: t } = currentState();
    const playing = usePlayback.getState().playing;
    const hits = doneBy(done(), part, t).hits;
    arcs.forEach(({ s }, i) => {
      const g = glow.current[i];
      if (!g) return;
      let f = 0;
      if (playing)
        for (const h of hits)
          if (h.sites.includes(s.id) && t - h.at < FLASH)
            f = Math.max(f, 1 - (t - h.at) / FLASH);
      g.visible = f > 0;
      g.scale.setScalar(1 + (1 - f) * 0.6);
      (g.material as MeshBasicMaterial).opacity = f;
    });
  });
  return (
    <>
      {arcs.map(({ s, cx, cz, radius, angle, span }, i) => {
        const k = lit.get(s.id) ?? 0;
        const color = DARK.clone()
          .lerp(LIT, k)
          .multiplyScalar(k ? 1.5 : 1);
        // A torus arc starts at angle 0 in its own plane; lying flat, its
        // plane's angle runs the other way round to the world's.
        const rot = -(angle - span / 2) - span;
        return (
          <group
            key={s.id}
            position={[cx, 0.03, cz]}
            rotation={[-Math.PI / 2, 0, rot]}
          >
            <mesh
              onPointerMove={(e) => {
                e.stopPropagation();
                hoverFrom(
                  hoverKey(part),
                  `${s.step} · ${k ? "reported" : "not reported yet"}, line ${
                    insideOf(part)?.sites.find((x) => x.id === s.id)?.line ??
                    "?"
                  }`,
                );
              }}
              onPointerOut={() => hoverGone(hoverKey(part))}
            >
              <torusGeometry args={[radius, k ? 0.04 : 0.028, 6, 12, span]} />
              <meshBasicMaterial color={color} toneMapped={false} />
            </mesh>
            <mesh
              ref={(m) => void (glow.current[i] = m)}
              visible={false}
              raycast={() => null}
            >
              <torusGeometry args={[radius, 0.09, 6, 12, span]} />
              <meshBasicMaterial
                color={LIT}
                transparent
                blending={AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
}
