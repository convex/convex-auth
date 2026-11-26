import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ComponentRef } from "react";
import {
  AdditiveBlending,
  Color,
  QuadraticBezierCurve3,
  Vector3,
  type Group,
  type Mesh,
} from "three";
import type { Movement } from "../model/schedule.ts";
import type { TokenRef } from "../model/types.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { Label } from "./Label.tsx";
import { anchorPosition, type Layout } from "./layout.ts";
import { Lod } from "./Lod.tsx";
import { MOVEMENT_COLORS, TONE_COLORS, TOKEN_COLORS } from "./palette.ts";

/** The path of a movement: one arc, or two through the place it passes. */
export function movementPath(
  layout: Layout,
  m: Movement,
): (t: number) => Vector3 {
  const points = [m.from, ...(m.via ? [m.via] : []), m.to].map((a) =>
    anchorPosition(layout, a),
  );
  const curves: QuadraticBezierCurve3[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const lift = Math.min(14, 2 + a.distanceTo(b) * 0.28);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y = Math.max(a.y, b.y) + lift;
    curves.push(new QuadraticBezierCurve3(a, mid, b));
  }
  const lengths = curves.map((c) => c.getLength());
  const total = lengths.reduce((x, y) => x + y, 0);
  return (t: number) => {
    let d = Math.min(Math.max(t, 0), 1) * total;
    for (let i = 0; i < curves.length; i++) {
      if (d <= lengths[i] || i === curves.length - 1)
        return curves[i].getPointAt(Math.min(1, d / lengths[i]));
      d -= lengths[i];
    }
    return points[points.length - 1].clone();
  };
}

/** Eases in and out so a traveller departs and arrives gently. */
const ease = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/** Every movement in flight now. */
export function Travellers({ layout }: { layout: Layout }) {
  const ids = usePlayback((s) => {
    void s.time;
    return currentState()
      .travellers.map((t) => t.movement.id)
      .join(",");
  });
  const movements = useMemo(
    () =>
      ids
        ? ids
            .split(",")
            .map((id) => world.timeline.movements.find((m) => m.id === id)!)
        : [],
    [ids],
  );
  return (
    <>
      {movements.map((m) => (
        <TravellerMesh key={m.id} movement={m} layout={layout} />
      ))}
    </>
  );
}

function TravellerMesh({
  movement,
  layout,
}: {
  movement: Movement;
  layout: Layout;
}) {
  const group = useRef<Group>(null);
  const head = useRef<Mesh>(null);
  const path = useMemo(
    () => movementPath(layout, movement),
    [layout, movement],
  );
  const select = usePlayback((s) => s.select);
  const selected = usePlayback(
    (s) => s.selected?.type === "movement" && s.selected.id === movement.id,
  );
  const color = useMemo(
    () =>
      new Color(
        movement.tone === "normal"
          ? MOVEMENT_COLORS[movement.kind]
          : TONE_COLORS[movement.tone],
      ),
    [movement],
  );
  const start = useMemo(() => path(0), [path]);

  useFrame(() => {
    const { time } = currentState();
    const p = (time - movement.start) / (movement.end - movement.start);
    group.current?.position.copy(path(ease(Math.min(Math.max(p, 0), 1))));
    if (head.current)
      head.current.scale.setScalar(
        (selected ? 1.5 : 1) * (1 + 0.15 * Math.sin(time * 12)),
      );
  });

  const big = movement.kind === "request" || movement.kind === "response";
  return (
    <>
      <Streak
        path={path}
        movement={movement}
        color={color}
        width={big ? 5 : 3.5}
      />
      <group
        ref={group}
        position={start}
        onClick={(e) => {
          e.stopPropagation();
          select({ type: "movement", id: movement.id });
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          hover.label = movement.label;
        }}
        onPointerOut={() => (hover.label = "")}
      >
        <mesh ref={head}>
          <sphereGeometry args={[big ? 0.55 : 0.4, 24, 16]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={4}
            toneMapped={false}
          />
        </mesh>
        {/* An invisible, larger target so a moving thing is easy to click. */}
        <mesh visible={false}>
          <sphereGeometry args={[1.4, 8, 8]} />
        </mesh>
        {movement.tokens.map((token, i) => (
          <group
            key={token.label}
            position={[(i - (movement.tokens.length - 1) / 2) * 2, 1.5, 0]}
          >
            <TokenMesh token={token} scale={1.5} labelled={false} />
          </group>
        ))}
        <Lod far={150}>
          <Label
            billboard
            position={[0, movement.tokens.length ? 3.4 : 1.3, 0]}
            fontSize={0.62}
            keepSize={[30, 2]}
            color="#f4f7ff"
            outlineWidth={0.03}
            outlineColor="#03050a"
          >
            {movement.tokens.length
              ? `${movement.label}  ·  ${movement.tokens.map((k) => k.label).join(" + ")}`
              : movement.label}
          </Label>
        </Lod>
      </group>
    </>
  );
}

const STREAK_POINTS = 40;

/**
 * The trail behind a traveller: the stretch of its path it just covered,
 * fading out. Computed from the time, so it stays in place while paused.
 */
function Streak({
  path,
  movement,
  color,
  width,
}: {
  path: (t: number) => Vector3;
  movement: Movement;
  color: Color;
  width: number;
}) {
  const line = useRef<ComponentRef<typeof Line>>(null);
  const initial = useMemo(
    () => Array.from({ length: STREAK_POINTS }, (_, i) => path(i * 0.002)),
    [path],
  );
  const colors = useMemo(
    () =>
      Array.from({ length: STREAK_POINTS }, (_, i) => {
        const k = Math.pow(i / (STREAK_POINTS - 1), 2);
        return color.clone().multiplyScalar(k * 1.6);
      }),
    [color],
  );
  const flat = useMemo(() => new Float32Array(STREAK_POINTS * 3), []);
  useFrame(() => {
    const l = line.current;
    if (!l) return;
    const { time } = currentState();
    const p = ease(
      Math.min(
        Math.max((time - movement.start) / (movement.end - movement.start), 0),
        1,
      ),
    );
    const tail = Math.max(0, p - 0.3);
    for (let i = 0; i < STREAK_POINTS; i++) {
      // Points never coincide: a zero-length segment breaks the line shader.
      const v = path(tail + ((p - tail) * i) / (STREAK_POINTS - 1) + i * 1e-5);
      flat[i * 3] = v.x;
      flat[i * 3 + 1] = v.y + i * 1e-4;
      flat[i * 3 + 2] = v.z;
    }
    l.geometry.setPositions(flat);
    const m = l.material;
    m.blending = AdditiveBlending;
    m.depthWrite = false;
  });
  return (
    <Line
      ref={line}
      points={initial}
      vertexColors={colors}
      lineWidth={width}
      transparent
      raycast={() => null}
    />
  );
}

/** An access token is a gold coin (a signed JWT); a refresh token a cyan key. */
export function TokenMesh({
  token,
  tint,
  scale = 1,
  labelled = true,
}: {
  token: TokenRef;
  tint?: string;
  scale?: number;
  labelled?: boolean;
}) {
  const spin = useRef<Group>(null);
  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation.y += delta * 1.6;
  });
  const color = tint ?? TOKEN_COLORS[token.kind];
  return (
    <group scale={scale}>
      <group ref={spin}>
        {token.kind === "access" ? (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.5, 0.5, 0.14, 6]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={1.6}
              metalness={0.9}
              roughness={0.25}
              toneMapped={false}
            />
          </mesh>
        ) : (
          <group rotation={[0, 0, Math.PI / 2]}>
            <mesh>
              <capsuleGeometry args={[0.2, 0.7, 6, 16]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={2.2}
                toneMapped={false}
              />
            </mesh>
            <mesh position={[0, 0.62, 0]}>
              <torusGeometry args={[0.24, 0.07, 8, 24]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={2.2}
                toneMapped={false}
              />
            </mesh>
          </group>
        )}
      </group>
      {labelled && (
        <Label
          billboard
          position={[0, 0.85, 0]}
          fontSize={0.42}
          color={color}
          weight="bold"
          outlineWidth={0.035}
          outlineColor="#03050a"
        >
          {token.label}
        </Label>
      )}
    </group>
  );
}
