/**
 * One moving thing per operation of the client (see `model/operations.ts`):
 * a bright body that goes from the module that reported a step to the next
 * one, in the order the steps were reported, out to the way out with its
 * call and back, and on to the storage keys it wrote. Behind it, the way it
 * came, fading. Its size is kept on screen, so that from the distance of
 * the whole browser region it still reads as the one thing acting, and
 * where it is going.
 *
 * Everything is a function of the playback time.
 */
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ComponentRef } from "react";
import {
  AdditiveBlending,
  Color,
  Vector3,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
} from "three";
import type { OpPath } from "../model/operations.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { anchorPosition } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";

/** Shown seconds an operation stays at its last place before it fades. */
const LINGER = 0.6;
/** The body's radius as a fraction of its distance to the camera. */
const ON_SCREEN = 0.011;
/** Its radius in world units, at least: close in, it is not huge. */
const LEAST = 0.35;

/**
 * A colour per kind of operation, from its name: the same kind always has
 * the same colour, and the world names no kind.
 */
export const opColor = (op: OpPath) => {
  if (op.tone === "error") return TONE_COLORS.error;
  let h = 0;
  for (const ch of op.kind) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return new Color().setHSL((h % 360) / 360, 0.75, 0.7).getStyle();
};

/** Where an operation is at time `t`, and how far along its path (0..n-1). */
export function opAt(
  op: OpPath,
  t: number,
  positions: Vector3[],
  out = new Vector3(),
): number {
  const p = op.points;
  if (t <= p[0].at) {
    out.copy(positions[0]);
    return 0;
  }
  for (let i = 0; i < p.length - 1; i++) {
    if (t < p[i + 1].at) {
      const k = (t - p[i].at) / (p[i + 1].at - p[i].at);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const a = positions[i];
      const b = positions[i + 1];
      out.lerpVectors(a, b, e);
      // An arc over the ground, higher for a longer way.
      out.y += Math.sin(Math.PI * e) * Math.min(6, 0.25 * a.distanceTo(b));
      return i + e;
    }
  }
  out.copy(positions[positions.length - 1]);
  return p.length - 1;
}

export function Operations() {
  // A live world is replaced as it grows: read its operations again then.
  const version = usePlayback((s) => s.version);
  const ops = useMemo(() => {
    void version;
    return world.timeline.ops;
  }, [version]);
  const live = usePlayback((s) => {
    const t = s.time;
    return world.timeline.ops
      .filter((o) => o.points[0].at <= t && t <= o.points.at(-1)!.at + LINGER)
      .map((o) => o.id)
      .join(",");
  });
  const shown = useMemo(
    () =>
      live
        ? live
            .split(",")
            .map((id) => ops.find((o) => o.id === id))
            .filter((o): o is OpPath => o !== undefined)
        : [],
    [live, ops],
  );
  return (
    <>
      {shown.map((op) => (
        <Operation key={`${op.id}@${op.points.length}`} op={op} />
      ))}
    </>
  );
}

const TRAIL = 48;

function Operation({ op }: { op: OpPath }) {
  const body = useRef<Group>(null);
  const core = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const line = useRef<ComponentRef<typeof Line>>(null);
  const select = usePlayback((s) => s.select);
  const positions = useMemo(
    () => op.points.map((p) => anchorPosition(p.anchor).clone()),
    [op],
  );
  const color = useMemo(() => new Color(opColor(op)), [op]);
  const colors = useMemo(
    () =>
      Array.from({ length: TRAIL }, (_, i) =>
        color.clone().multiplyScalar(Math.pow(i / (TRAIL - 1), 1.5) * 1.4),
      ),
    [color],
  );
  const flat = useMemo(() => new Float32Array(TRAIL * 3), []);
  const at = useMemo(() => new Vector3(), []);
  const v = useMemo(() => new Vector3(), []);

  useFrame(({ camera }) => {
    const { time } = currentState();
    const end = op.points.at(-1)!.at;
    const fade = time > end ? Math.max(0, 1 - (time - end) / LINGER) : 1;
    const along = opAt(op, time, positions, at);
    const g = body.current;
    if (g) {
      g.position.copy(at);
      const r = Math.max(LEAST, camera.position.distanceTo(at) * ON_SCREEN);
      g.scale.setScalar(r * (0.6 + 0.4 * fade));
    }
    for (const m of [core.current, halo.current])
      if (m)
        (m.material as MeshBasicMaterial).opacity =
          (m === core.current ? 1 : 0.28) * fade;
    // The way it came: the last stretch of its path, fading behind it.
    const l = line.current;
    if (l) {
      const from = Math.max(0, along - 2.5);
      for (let i = 0; i < TRAIL; i++) {
        const s = from + ((along - from) * i) / (TRAIL - 1);
        // The time at path position s.
        const j = Math.min(Math.floor(s), op.points.length - 1);
        const k = s - j;
        const t =
          j >= op.points.length - 1
            ? op.points[j].at
            : op.points[j].at + k * (op.points[j + 1].at - op.points[j].at);
        opAt(op, t, positions, v);
        flat[i * 3] = v.x;
        flat[i * 3 + 1] = v.y + i * 1e-4;
        flat[i * 3 + 2] = v.z + i * 1e-5;
      }
      l.geometry.setPositions(flat);
      l.material.opacity = fade;
      l.material.blending = AdditiveBlending;
      l.material.depthWrite = false;
    }
  });

  const label = `${op.kind} · ${op.points
    .map((p) => p.step)
    .filter((s, i, a) => a.indexOf(s) === i)
    .join(" → ")}`;
  return (
    <>
      <Line
        ref={line}
        points={Array.from(
          { length: TRAIL },
          (_, i) => [i * 1e-3, 0, 0] as [number, number, number],
        )}
        vertexColors={colors}
        lineWidth={4}
        transparent
        raycast={() => null}
      />
      <group
        ref={body}
        onClick={(e) => {
          if (isDrag(e)) return;
          e.stopPropagation();
          select({ type: "op", id: op.id });
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          hover.label = label;
        }}
        onPointerOut={() => (hover.label = "")}
      >
        <mesh ref={core}>
          <sphereGeometry args={[1, 24, 16]} />
          <meshBasicMaterial
            color={color.clone().multiplyScalar(3)}
            toneMapped={false}
            transparent
          />
        </mesh>
        <mesh ref={halo}>
          <sphereGeometry args={[2.2, 24, 16]} />
          <meshBasicMaterial
            color={color}
            toneMapped={false}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </mesh>
      </group>
    </>
  );
}
