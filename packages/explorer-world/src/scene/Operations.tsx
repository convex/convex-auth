/**
 * One moving thing per operation of the client (see `model/operations.ts`):
 * a bright body that goes from the module that reported a step to the next
 * one, in the order the steps were reported, out to the way out with its
 * call and back, and on to the storage keys it wrote. Behind it, the way it
 * came, fading. Its size is kept on screen, so that from the distance of
 * the whole browser region it still reads as the one thing acting, and
 * where it is going.
 *
 * What its call carried rides with it, one small shape per thing in a row
 * over it (see {@link Loads}): out to the way out, and back to the storage
 * key that took it, where it is put down.
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
  Quaternion,
} from "three";
import { loadName, type OpLoad, type OpPath } from "../model/operations.ts";
import type { Cargo } from "../model/recording.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { anchorPosition } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";
import { CargoMesh, heldPlace } from "./Travellers.tsx";

/** Shown seconds an operation stays at its last place before it fades. */
const LINGER = 0.6;
/** The body's radius as a fraction of its distance to the camera. */
const ON_SCREEN = 0.011;
/** Its radius in world units, at least: close in, it is not huge. */
const LEAST = 0.35;

/**
 * A colour per kind of operation, from its name: the same kind always has
 * the same colour, and the world names no kind. An operation that failed is
 * red from the step that reported the error (at time `t`), not before.
 */
export const opColor = (op: OpPath, t = Infinity) => {
  if (op.tone === "error" && t >= (op.errorAt ?? -Infinity))
    return TONE_COLORS.error;
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

/** Until when an operation is drawn: its fade, and every load put down resting on its key. */
const shownUntil = (o: OpPath) =>
  Math.max(o.points.at(-1)!.at + LINGER, ...o.loads.map((l) => l.held ?? 0));

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
      .filter((o) => o.points[0].at <= t && t <= shownUntil(o))
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
  // The way it came keeps its kind's colour; the body turns red once the
  // error is reported.
  const color = useMemo(() => new Color(opColor(op, -Infinity)), [op]);
  const failed = useMemo(() => new Color(opColor(op)), [op]);
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
    // What the client did by itself is drawn quieter than an action.
    const quiet = op.unasked ? 0.45 : 1;
    const fade =
      (time > end ? Math.max(0, 1 - (time - end) / LINGER) : 1) * quiet;
    const along = opAt(op, time, positions, at);
    const g = body.current;
    if (g) {
      g.position.copy(at);
      const r = Math.max(LEAST, camera.position.distanceTo(at) * ON_SCREEN);
      g.scale.setScalar(r * (op.unasked ? 0.6 : 1) * (0.6 + 0.4 * fade));
    }
    const now = time >= (op.errorAt ?? Infinity) ? failed : color;
    for (const m of [core.current, halo.current])
      if (m) {
        const mat = m.material as MeshBasicMaterial;
        mat.opacity = (m === core.current ? 1 : 0.28) * fade;
        mat.color.copy(now);
        if (m === core.current) mat.color.multiplyScalar(3);
      }
    // The way it came: the last stretch of its path, fading behind it.
    const l = line.current;
    if (l) {
      const from = Math.max(0, along - 4);
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
      {op.loads.length > 0 && <Loads op={op} positions={positions} />}
    </>
  );
}

/** Shown seconds a load takes to appear, or to go into the way out or down onto its key. */
const HAND = 0.3;
/** A load's size, and the gap between loads, as multiples of the body's radius. */
const LOAD_SIZE = 2.6;
const LOAD_GAP = 3;
/** How high over the body the row of loads rides, in body radii. */
const LOAD_LIFT = 3.6;

/**
 * What the operation's call carried, riding over its body: a row facing
 * the camera, one shape per thing, as the storage keys draw a token (a coin,
 * a key), and a hollow ring for a field the recorder blanked. A load
 * appears where the body picked it up, goes into the way out, or comes
 * back from it and is put down onto the key that took it.
 */
function Loads({ op, positions }: { op: OpPath; positions: Vector3[] }) {
  const groups = useRef<(Group | null)[]>([]);
  const select = usePlayback((s) => s.select);
  const at = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  const up = useMemo(() => new Vector3(), []);
  const goal = useMemo(() => new Vector3(), []);
  const still = useMemo(() => new Quaternion(), []);

  useFrame(({ camera }) => {
    const { time } = currentState();
    opAt(op, time, positions, at);
    const r =
      Math.max(LEAST, camera.position.distanceTo(at) * ON_SCREEN) *
      (op.unasked ? 0.6 : 1);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    // The loads riding now, in a row.
    const riding = op.loads.filter(
      (l) => time >= l.from - HAND && time <= l.to,
    );
    op.loads.forEach((l, i) => {
      const g = groups.current[i];
      if (!g) return;
      // One put down rests on its key until the key shows it held.
      const rest =
        l.held !== undefined ? Math.max(l.to + HAND, l.held) : l.to + HAND;
      const shown = time >= l.from - HAND && time < rest;
      g.visible = shown;
      if (!shown) return;
      const slot = Math.max(0, riding.indexOf(l));
      const n = Math.max(1, riding.length);
      g.position
        .copy(at)
        .addScaledVector(right, (slot - (n - 1) / 2) * LOAD_GAP * r)
        .addScaledVector(up, LOAD_LIFT * r);
      g.quaternion.copy(camera.quaternion);
      let size = LOAD_SIZE * r;
      if (time < l.from) {
        // Appearing: from the key it was picked up at, or out of the body.
        const k = (time - (l.from - HAND)) / HAND;
        if (l.at) {
          const held = heldPlace(l.at, 0, 1, camera.position, goal);
          g.position.lerp(goal, 1 - k);
          g.quaternion.slerp(still, 1 - k);
          size = size * k + held * (1 - k);
        } else size *= k;
      } else if (time > l.to) {
        const k = Math.min(1, (time - l.to) / HAND);
        if (l.dir === "back" && l.at) {
          // Put down onto the key that took it, at rest as the key draws
          // what it holds.
          const held = heldPlace(l.at, 0, 1, camera.position, goal);
          g.position.lerp(goal, k);
          g.quaternion.slerp(still, k);
          size = size * (1 - k) + held * k;
        } else size *= 1 - k;
      }
      g.scale.setScalar(Math.max(1e-3, size));
    });
  });

  return (
    <>
      {op.loads.map((l, i) => (
        <group
          key={i}
          ref={(g) => {
            groups.current[i] = g;
          }}
          visible={false}
          onClick={(e) => {
            if (isDrag(e)) return;
            e.stopPropagation();
            select({ type: "op", id: op.id });
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            hover.label = `${l.dir === "out" ? "carried out" : "carried back"}: ${loadName(l.load)}`;
          }}
          onPointerOut={() => (hover.label = "")}
        >
          <LoadMesh load={l.load} />
        </group>
      ))}
    </>
  );
}

const BLANKED_COLOR = "#c3cad8";

function LoadMesh({ load }: { load: OpLoad["load"] }) {
  if (load.kind === "blanked")
    return (
      <mesh>
        <torusGeometry args={[0.36, 0.12, 10, 28]} />
        <meshStandardMaterial
          color={BLANKED_COLOR}
          emissive={BLANKED_COLOR}
          emissiveIntensity={1.4}
          toneMapped={false}
        />
      </mesh>
    );
  const cargo: Cargo = load.cargo ?? {
    table: "",
    row: load.secret,
    label: `${load.type} secret ${load.secret}`,
    secret: load.secret,
  };
  return <CargoMesh cargo={cargo} labelled={false} />;
}
