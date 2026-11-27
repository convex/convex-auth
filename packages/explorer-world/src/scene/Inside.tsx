/**
 * A part opened up. Close in on a module and its inside rises above it, on
 * a disc of its own (`model/insideLayout.ts`): what it exports (the members
 * of its main export around it), what it holds (its stored keys, the lock
 * on one, its state), and a mark for each place in its code that reports a
 * step, on the export or member it sits in. A mark lights once running code
 * reported that step, and flashes as it does; the others stay dark. Only one
 * part is open at a time: the selected one from nearer than OPEN_SELECTED,
 * else the nearest within OPEN_NEAR. Inside it, names come by distance as
 * everywhere: the exports while it is open, the members and what it holds
 * nearer, the steps only within a few metres. A pointer on a place shows
 * its own line from the source.
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
  layInside,
  type InsideLayout,
  type LaidPlace,
} from "../model/insideLayout.ts";
import { done, insideOf } from "../insides.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { KeepSize, Label } from "./Label.tsx";
import { useDeclutter } from "./Labels.tsx";
import { anchorPosition, placementOf } from "./look.ts";

/** A selected part opens from this near (m); a part not selected from this near. */
export const OPEN_SELECTED = 16;
export const OPEN_NEAR = 8;
/** Names of members and holdings from this near (m); names of steps from this near. */
const NEAR_MEMBERS = 9.5;
const NEAR_STEPS = 3.4;
/** How high the disc floats over the top of the part (m). */
const LIFT = 1.1;
/** How long a mark flashes after its step was reported (s of shown time). */
const FLASH = 1.4;

const LIT = new Color("#ffd98a");
const DARK = new Color("#2a3352");

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

const centre = new Vector3();

export function Inside() {
  const ids = useMemo(openable, []);
  const [open, setOpen] = useState<string | null>(null);
  const last = useRef(-1);
  const controls = useThree((s) => s.controls) as unknown as {
    setLookAt?: (
      ...a: [number, number, number, number, number, number, boolean]
    ) => void;
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
      const reach =
        sel?.type === "part" && sel.id === id ? OPEN_SELECTED : OPEN_NEAR;
      // The selected part wins while it is in reach.
      const chosen = reach === OPEN_SELECTED;
      if (d <= reach && (chosen || d < bestD)) {
        if (chosen) {
          best = id;
          break;
        }
        bestD = d;
        best = id;
      }
    }
    if (best !== open) {
      setOpen(best);
      usePlayback.setState({ open: best });
    }
  });

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

function OpenPart({ id }: { id: string }) {
  const inside = insideOf(id)!;
  const lay = useMemo(() => layInside(inside), [inside]);
  const color = placementOf(id)?.color ?? "#9fc4ff";
  const at = useMemo(() => discCentre(id), [id]);
  const top = useMemo(
    () => anchorPosition(id).setY(anchorPosition(id).y - 0.6),
    [id],
  );
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
        <circleGeometry args={[lay.radius + 0.6, 64]} />
        <meshBasicMaterial
          color={new Color(color).multiplyScalar(0.12)}
          transparent
          opacity={0.96}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.004} raycast={() => null}>
        <ringGeometry args={[lay.radius + 0.56, lay.radius + 0.6, 96]} />
        <meshBasicMaterial
          color={new Color(color).multiplyScalar(1.1)}
          toneMapped={false}
        />
      </mesh>
      {lay.places.map((p) => (
        <PlaceShape key={p.place.id} part={id} laid={p} color={color} />
      ))}
      {lay.holds.map((h, i) => (
        <HoldShape key={`${h.kind}:${h.name}:${i}`} part={id} hold={h} />
      ))}
      <Marks part={id} lay={lay} />
    </group>
  );
}

const SIZE: Record<LaidPlace["shape"], number> = {
  class: 0.4,
  function: 0.14,
  member: 0.1,
  value: 0.12,
  type: 0.05,
  reexport: 0.06,
};

function PlaceShape({
  part,
  laid,
  color,
}: {
  part: string;
  laid: LaidPlace;
  color: string;
}) {
  const { place, shape } = laid;
  const r = SIZE[shape];
  const tint = new Color(color).multiplyScalar(
    shape === "type" || shape === "reexport" ? 0.45 : 1.1,
  );
  const handlers = {
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      hover.label = `${place.of ? `${place.of}.` : ""}${place.name} · ${place.kind}${
        place.summary ? ` — ${place.summary}` : ""
      }`;
    },
    onPointerOut: () => (hover.label = ""),
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (isDrag(e)) return;
      usePlayback.getState().select({ type: "part", id: part });
    },
  };
  const named = shape !== "type" && shape !== "reexport";
  const h = shape === "class" ? 0.08 : shape === "value" ? 0.05 : r * 1.6;
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
      {named && (
        <PlaceName
          id={`${part}|${place.id}`}
          text={place.name}
          y={h + (shape === "class" ? 0.22 : 0.16)}
          size={shape === "member" ? 0.085 : shape === "class" ? 0.16 : 0.11}
          far={shape === "member" ? NEAR_MEMBERS : undefined}
          priority={shape === "member" ? 54 : 58}
        />
      )}
    </group>
  );
}

function PlaceName({
  id,
  text,
  y,
  size,
  far,
  priority,
  color = "#ffffff",
}: {
  id: string;
  text: string;
  y: number;
  size: number;
  far?: number;
  priority: number;
  color?: string;
}) {
  const group = useDeclutter(`inside:${id}`, {
    chars: text.length,
    lines: 1,
    size,
    grow: { distance: 5, max: 1.8 },
    priority,
    hideFar: far,
  });
  return (
    <group ref={group} position={[0, y, 0]}>
      <KeepSize distance={5} max={1.8}>
        <Billboard>
          <Label
            fontSize={size}
            color={color}
            outlineWidth={size * 0.1}
            outlineColor="#03050a"
            weight={size >= 0.15 ? "bold" : "regular"}
          >
            {text}
          </Label>
        </Billboard>
      </KeepSize>
    </group>
  );
}

function HoldShape({
  part,
  hold,
}: {
  part: string;
  hold: InsideLayout["holds"][number];
}) {
  const handlers = {
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      hover.label =
        hold.kind === "key"
          ? `${hold.name} · a key it stores`
          : hold.kind === "lock"
            ? `a lock named after ${hold.name}`
            : `${hold.name} · state it keeps`;
    },
    onPointerOut: () => (hover.label = ""),
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
          color={key ? "#9fe8d8" : "#6c7aa0"}
          toneMapped={false}
        />
      </mesh>
      <PlaceName
        id={`${part}|hold:${hold.kind}:${hold.name}`}
        text={hold.name}
        y={key ? 0.26 : 0.1}
        size={key ? 0.075 : 0.05}
        far={key ? NEAR_MEMBERS : NEAR_STEPS}
        priority={key ? 53 : 49}
        color={key ? "#c9fff2" : "#aab6d8"}
      />
    </group>
  );
}

/**
 * One mark per site, lit once reported by now (a step that could be one of
 * several sites half-lights each), flashing as it is reported. Its name
 * shows within NEAR_STEPS, and on a flash.
 */
function Marks({ part, lay }: { part: string; lay: InsideLayout }) {
  const refs = useRef<(Mesh | null)[]>([]);
  const glow = useRef<(Mesh | null)[]>([]);
  const [flashing, setFlashing] = useState<string[]>([]);
  const index = useMemo(
    () => new Map(lay.sites.map((s, i) => [s.id, i])),
    [lay],
  );
  // For scripted checks: the marks lit now.
  (globalThis as { explorerMarks?: unknown }).explorerMarks = () => {
    const so = doneBy(done(), part, currentState().time);
    return lay.sites.map((s) => ({
      step: s.step,
      place: s.place,
      lit: so.hits.some((h) => h.sites.includes(s.id)),
    }));
  };
  useFrame(() => {
    const t = currentState().time;
    const playing = usePlayback.getState().playing;
    const so = doneBy(done(), part, t);
    const level = new Map<string, number>();
    const flash = new Map<string, number>();
    for (const h of so.hits)
      for (const site of h.sites) {
        const k = h.sites.length === 1 ? 1 : 0.5;
        level.set(site, Math.max(level.get(site) ?? 0, k));
        // A flash is the moment of the report, while it plays.
        if (playing && t - h.at < FLASH)
          flash.set(site, 1 - (t - h.at) / FLASH);
      }
    lay.sites.forEach((s, i) => {
      const m = refs.current[i];
      if (m) {
        const k = level.get(s.id) ?? 0;
        (m.material as MeshBasicMaterial).color
          .copy(DARK)
          .lerp(LIT, k)
          .multiplyScalar(k ? 1.6 : 1);
      }
      const g = glow.current[i];
      if (g) {
        const f = flash.get(s.id) ?? 0;
        g.visible = f > 0;
        g.scale.setScalar(1 + (1 - f) * 2.5);
        (g.material as MeshBasicMaterial).opacity = f * 0.9;
      }
    });
    const now = [...flash.keys()].filter((k) => index.has(k)).sort();
    if (now.join() !== flashing.join()) setFlashing(now);
  });
  return (
    <>
      {lay.sites.map((s, i) => (
        <group key={s.id} position={[s.x, 0.05, s.z]}>
          <mesh
            ref={(m) => void (refs.current[i] = m)}
            onPointerMove={(e) => {
              e.stopPropagation();
              hover.label = `${s.step} · a step it can report, at line ${
                insideOf(part)?.sites.find((x) => x.id === s.id)?.line ?? "?"
              }`;
            }}
            onPointerOut={() => (hover.label = "")}
          >
            <sphereGeometry args={[0.035, 10, 8]} />
            <meshBasicMaterial color={DARK} toneMapped={false} />
          </mesh>
          <mesh
            ref={(m) => void (glow.current[i] = m)}
            visible={false}
            raycast={() => null}
          >
            <sphereGeometry args={[0.06, 12, 8]} />
            <meshBasicMaterial
              color={LIT}
              transparent
              blending={AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <StepName
            id={`${part}|${s.id}`}
            text={s.step}
            loud={flashing.includes(s.id)}
          />
        </group>
      ))}
    </>
  );
}

function StepName({
  id,
  text,
  loud,
}: {
  id: string;
  text: string;
  loud: boolean;
}) {
  return (
    <PlaceName
      key={loud ? "loud" : "quiet"}
      id={`${id}${loud ? "!" : ""}`}
      text={text}
      y={0.12}
      size={loud ? 0.07 : 0.05}
      far={loud ? OPEN_SELECTED : NEAR_STEPS}
      priority={loud ? 59 : 48}
      color={loud ? "#ffe3a3" : "#c8cfe6"}
    />
  );
}
