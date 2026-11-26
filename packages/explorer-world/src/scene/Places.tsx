import { QuadraticBezierLine, RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MathUtils,
  ShaderMaterial,
  Vector3,
  type Group,
  type MeshStandardMaterial,
} from "three";
import { GATE, SCHEDULER, SIGNER } from "../model/schedule.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { KeepSize, Label } from "./Label.tsx";
import type { Layout } from "./layout.ts";
import { Lod } from "./Lod.tsx";
import { REGION_COLORS, TONE_COLORS } from "./palette.ts";
import { TokenMesh } from "./Travellers.tsx";

const PLATFORM = new Color(REGION_COLORS.platform);

function usePick(id: string, label: string) {
  const select = usePlayback((s) => s.select);
  return {
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      select({ type: "place", id });
    },
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      hover.label = label;
    },
    onPointerOut: () => (hover.label = ""),
  };
}

const columnVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const columnFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.3);
    float scan = smoothstep(0.85, 1.0, fract(vUv.y * 5.0 - uTime * (0.4 + uGlow * 2.0)));
    float ribs = smoothstep(0.7, 1.0, sin(vUv.x * 120.0) * 0.5 + 0.5) * 0.3;
    gl_FragColor = vec4(uColor, fade * (0.12 + ribs * 0.1 + scan * (0.2 + uGlow * 0.5) + uGlow * 0.35));
  }
`;

/** The platform's check of the access token, where requests enter. */
export function Gate({ layout }: { layout: Layout }) {
  const position = layout.places.get(GATE)!;
  const rings = useRef<MeshStandardMaterial[]>([]);
  const column = useRef<ShaderMaterial>(null);
  const spin = useRef<Group>(null);
  const glow = useRef(0);
  const pick = usePick(GATE, "token check");
  const uniforms = useMemo(
    () => ({
      uColor: { value: PLATFORM },
      uGlow: { value: 0 },
      uTime: { value: 0 },
    }),
    [],
  );
  useFrame(({ clock }, delta) => {
    const state = currentState();
    // A request lights the gate as it passes through.
    const passing = state.travellers.some(
      (t) => t.movement.via === GATE && t.progress > 0.2 && t.progress < 0.65,
    );
    glow.current = MathUtils.damp(glow.current, passing ? 1 : 0, 6, delta);
    for (const m of rings.current)
      if (m) m.emissiveIntensity = 1.4 + glow.current * 5;
    if (column.current) {
      column.current.uniforms.uGlow.value = glow.current;
      column.current.uniforms.uTime.value = clock.elapsedTime;
    }
    if (spin.current)
      spin.current.rotation.y += delta * (0.25 + glow.current * 2.5);
  });
  const ground = position.y - 3.2;
  return (
    <group position={[position.x, ground, position.z]} {...pick}>
      <mesh position={[0, 5, 0]}>
        <cylinderGeometry args={[3.2, 3.2, 10, 64, 1, true]} />
        <shaderMaterial
          ref={column}
          vertexShader={columnVertex}
          fragmentShader={columnFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
        />
      </mesh>
      {[0.05, 3.2, 6.4].map((y, i) => (
        <mesh key={y} position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry
            args={[3.25 - i * 0.12, i === 0 ? 0.16 : 0.07, 10, 96]}
          />
          <meshStandardMaterial
            ref={(m) => {
              if (m) rings.current[i] = m;
            }}
            color={PLATFORM}
            emissive={PLATFORM}
            emissiveIntensity={1.4}
            toneMapped={false}
          />
        </mesh>
      ))}
      <group ref={spin} position={[0, 3.2, 0]}>
        {[0, 1, 2, 3].map((i) => (
          <mesh
            key={i}
            position={[
              Math.sin((i * Math.PI) / 2) * 3.9,
              0,
              Math.cos((i * Math.PI) / 2) * 3.9,
            ]}
          >
            <octahedronGeometry args={[0.28, 0]} />
            <meshStandardMaterial
              color={PLATFORM}
              emissive={PLATFORM}
              emissiveIntensity={2}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      <Lod far={130}>
        <Label
          billboard
          position={[0, 11.4, 0]}
          fontSize={0.9}
          color="#d9d3ff"
          weight="bold"
          outlineWidth={0.04}
          outlineColor="#03050a"
        >
          token check
        </Label>
      </Lod>
      <Lod far={46}>
        <Label
          billboard
          position={[0, 10.5, 0]}
          fontSize={0.34}
          color="#aab4d4"
          maxWidth={9}
          textAlign="center"
        >
          The platform verifies the access token on every request, before the
          function runs
        </Label>
      </Lod>
    </group>
  );
}

/** The React app in the browser: a floating screen behind the tokens it holds. */
export function Device({ layout, holder }: { layout: Layout; holder: string }) {
  const island = layout.islands.get(holder)!;
  const color = new Color(REGION_COLORS[holder]);
  const small = holder !== "browser";
  const w = small ? 2.6 : 8.4;
  const h = small ? 4.4 : 5.2;
  return (
    <group
      position={[
        island.center.x,
        island.center.y + (small ? 2.8 : 3.6),
        island.center.z - island.radius * 0.45,
      ]}
      rotation={[-0.08, 0.25, 0]}
    >
      <RoundedBox args={[w + 0.4, h + 0.4, 0.3]} radius={0.2} smoothness={3}>
        <meshStandardMaterial color="#0b1020" metalness={0.8} roughness={0.3} />
      </RoundedBox>
      <mesh position={[0, 0, 0.16]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial
          color="#05070e"
          emissive={color}
          emissiveIntensity={0.08}
        />
      </mesh>
      {!small && (
        <group position={[0, 0, 0.18]}>
          {/* A sign-in card, drawn in light. */}
          <mesh position={[0, 0.2, 0]}>
            <planeGeometry args={[3.6, 3.6]} />
            <meshStandardMaterial
              color="#0a1020"
              emissive={color}
              emissiveIntensity={0.18}
            />
          </mesh>
          {[1.2, 0.45, -0.3].map((y, i) => (
            <mesh key={y} position={[0, y, 0.01]}>
              <planeGeometry
                args={[i === 0 ? 1.6 : 3, i === 0 ? 0.22 : 0.42]}
              />
              <meshStandardMaterial
                color="#0a1020"
                emissive={color}
                emissiveIntensity={i === 0 ? 1.2 : 0.35}
              />
            </mesh>
          ))}
          <mesh position={[0, -1.05, 0.01]}>
            <planeGeometry args={[3, 0.46]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={1.1}
            />
          </mesh>
          <Label
            position={[0, -2.25, 0.02]}
            fontSize={0.26}
            color="#9fb6e8"
            letterSpacing={0.14}
          >
            REACT APP · CONVEX CLIENT
          </Label>
        </group>
      )}
    </group>
  );
}

/** The deployment's key, which signs every access token. */
export function Signer({ layout }: { layout: Layout }) {
  const position = layout.places.get(SIGNER)!;
  const core = useRef<MeshStandardMaterial>(null);
  const halo = useRef<Group>(null);
  const glow = useRef(0);
  const gold = useMemo(() => new Color("#ffd36b"), []);
  const pick = usePick(SIGNER, "signing key");
  useFrame((_, delta) => {
    const signing = currentState().travellers.some(
      (t) => t.movement.kind === "sign",
    );
    glow.current = MathUtils.damp(glow.current, signing ? 1 : 0, 6, delta);
    if (core.current) core.current.emissiveIntensity = 0.6 + glow.current * 6;
    if (halo.current) {
      halo.current.rotation.y += delta * (0.3 + glow.current * 3);
      halo.current.scale.setScalar(1 + glow.current * 0.3);
    }
  });
  return (
    <group position={position} {...pick}>
      <mesh position={[0, 2.2, 0]}>
        <cylinderGeometry args={[0.35, 0.9, 4.4, 4]} />
        <meshStandardMaterial
          color="#0d1324"
          metalness={0.8}
          roughness={0.25}
        />
      </mesh>
      <mesh position={[0, 5, 0]}>
        <octahedronGeometry args={[0.7, 0]} />
        <meshStandardMaterial
          ref={core}
          color="#1a1206"
          emissive={gold}
          emissiveIntensity={0.6}
          toneMapped={false}
        />
      </mesh>
      <group ref={halo} position={[0, 5, 0]}>
        <mesh rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[1.3, 0.03, 6, 64]} />
          <meshStandardMaterial
            color={gold}
            emissive={gold}
            emissiveIntensity={1.5}
            toneMapped={false}
          />
        </mesh>
      </group>
      <Lod far={80}>
        <Label
          billboard
          position={[0, 7.2, 0]}
          fontSize={0.6}
          color="#ffe2a0"
          weight="bold"
          outlineWidth={0.03}
          outlineColor="#03050a"
        >
          deployment key
        </Label>
      </Lod>
      <Lod far={34}>
        <Label billboard position={[0, 6.5, 0]} fontSize={0.28} color="#9aa6c4">
          signs access tokens (JWTs)
        </Label>
      </Lod>
    </group>
  );
}

/** The platform's scheduler, which runs functions after a commit. */
export function Scheduler({ layout }: { layout: Layout }) {
  const position = layout.places.get(SCHEDULER)!;
  const hand = useRef<Group>(null);
  const face = useRef<MeshStandardMaterial>(null);
  const glow = useRef(0);
  const pick = usePick(SCHEDULER, "scheduler");
  useFrame((_, delta) => {
    const state = currentState();
    const busy = state.travellers.some(
      (t) => t.movement.kind === "schedule" || t.movement.from === SCHEDULER,
    );
    glow.current = MathUtils.damp(glow.current, busy ? 1 : 0, 5, delta);
    if (hand.current)
      hand.current.rotation.z -= delta * (0.4 + glow.current * 6);
    if (face.current) face.current.emissiveIntensity = 0.8 + glow.current * 4;
  });
  return (
    <group position={position} {...pick}>
      <mesh position={[0, 1.6, 0]}>
        <cylinderGeometry args={[0.25, 0.6, 3.2, 8]} />
        <meshStandardMaterial
          color="#0d1324"
          metalness={0.8}
          roughness={0.25}
        />
      </mesh>
      <group position={[0, 5, 0]}>
        <mesh>
          <torusGeometry args={[1.5, 0.08, 8, 64]} />
          <meshStandardMaterial
            ref={face}
            color={PLATFORM}
            emissive={PLATFORM}
            emissiveIntensity={0.8}
            toneMapped={false}
          />
        </mesh>
        {Array.from({ length: 12 }, (_, i) => (
          <mesh
            key={i}
            position={[
              Math.sin((i / 12) * Math.PI * 2) * 1.2,
              Math.cos((i / 12) * Math.PI * 2) * 1.2,
              0,
            ]}
          >
            <boxGeometry args={[0.06, 0.2, 0.06]} />
            <meshStandardMaterial
              color={PLATFORM}
              emissive={PLATFORM}
              emissiveIntensity={1}
              toneMapped={false}
            />
          </mesh>
        ))}
        <group ref={hand}>
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[0.08, 1.0, 0.08]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#ffffff"
              emissiveIntensity={2}
              toneMapped={false}
            />
          </mesh>
        </group>
      </group>
      <Lod far={80}>
        <Label
          billboard
          position={[0, 7.2, 0]}
          fontSize={0.6}
          color="#d9d3ff"
          weight="bold"
          outlineWidth={0.03}
          outlineColor="#03050a"
        >
          scheduler
        </Label>
      </Lod>
    </group>
  );
}

/**
 * The dependencies between regions: the app uses each component, the password
 * component uses the rate limiter, the browser reaches the app through the
 * token check.
 */
export function Links({ layout }: { layout: Layout }) {
  const links = useMemo(() => {
    const out: { from: Vector3; to: Vector3; color: string }[] = [];
    for (const r of world.structure.regions) {
      if (!r.parent || r.parent === "platform") continue;
      const a = layout.islands.get(r.parent)?.center;
      const b = layout.islands.get(r.id)?.center;
      if (a && b)
        out.push({ from: a, to: b, color: REGION_COLORS[r.id] ?? "#fff" });
    }
    const gate = layout.places.get(GATE)!;
    const app = layout.islands.get("app")!.center;
    for (const client of ["browser", "elsewhere"]) {
      const c = layout.islands.get(client)?.center;
      if (c) out.push({ from: c, to: gate, color: REGION_COLORS[client] });
    }
    out.push({ from: gate, to: app, color: REGION_COLORS.platform });
    return out;
  }, [layout]);
  return (
    <>
      {links.map((l, i) => {
        const mid = l.from.clone().add(l.to).multiplyScalar(0.5);
        mid.y = Math.min(l.from.y, l.to.y) - 2.5;
        return (
          <QuadraticBezierLine
            key={i}
            start={l.from.clone().setY(l.from.y - 0.8)}
            end={l.to.clone().setY(l.to.y - 0.8)}
            mid={mid}
            color={l.color}
            lineWidth={1.4}
            dashed
            dashScale={2.2}
            dashSize={0.6}
            gapSize={0.9}
            transparent
            opacity={0.45}
            raycast={() => null}
          />
        );
      })}
    </>
  );
}

/** The tokens a client holds now, floating above it. */
export function Wallet({ holder, layout }: { holder: string; layout: Layout }) {
  const island = layout.islands.get(holder)!;
  const held = usePlayback((s) => {
    void s.time;
    return (currentState().holdings.get(holder) ?? [])
      .map((k) => `${k.kind}:${k.label}`)
      .join(",");
  });
  const tokens = useMemo(
    () =>
      held
        ? held.split(",").map((entry) => {
            const [kind, label] = entry.split(":");
            return { kind: kind as "access" | "refresh", label };
          })
        : [],
    [held],
  );
  const select = usePlayback((s) => s.select);
  const replayed = holder !== "browser";
  return (
    <group position={[island.center.x, island.center.y + 4.4, island.center.z]}>
      {tokens.map((token, i) => (
        <group
          key={`${token.kind}:${token.label}`}
          position={[(i - (tokens.length - 1) / 2) * 3.2, 0.6, 1]}
          onClick={(e) => {
            e.stopPropagation();
            select({ type: "token", holder, label: token.label });
          }}
        >
          <TokenMesh
            token={token}
            scale={2.1}
            tint={replayed ? TONE_COLORS.error : undefined}
          />
          <Lod far={50}>
            <Label
              billboard
              position={[0, -1.4, 0]}
              fontSize={0.34}
              color="#aab4d4"
              letterSpacing={0.08}
            >
              {(replayed
                ? "copy of refresh token"
                : token.kind === "access"
                  ? "access token"
                  : "refresh token"
              ).toUpperCase()}
            </Label>
          </Lod>
        </group>
      ))}
    </group>
  );
}

/** A banner over a region while an alert lasts, such as a revoked session. */
export function AlertBanners({ layout }: { layout: Layout }) {
  const key = usePlayback((s) => {
    void s.time;
    return currentState()
      .alerts.map((a) => `${a.region}|${a.text}`)
      .join("\n");
  });
  if (!key) return null;
  return (
    <>
      {key.split("\n").map((entry) => {
        const [region, text] = entry.split("|");
        const island = layout.islands.get(region);
        if (!island) return null;
        return (
          <KeepSize
            key={entry}
            distance={30}
            max={2.4}
            position={[
              island.center.x,
              island.center.y + 15,
              island.center.z + island.radius * 0.3,
            ]}
          >
            <Label
              billboard
              fontSize={0.8}
              color={TONE_COLORS.error}
              weight="bold"
              outlineWidth={0.05}
              outlineColor="#1a0006"
            >
              WARNING · LOGGED BY THE CORE
            </Label>
            <Label
              billboard
              position={[0, -1.1, 0]}
              fontSize={0.4}
              color="#ffd0d8"
              maxWidth={16}
              textAlign="center"
              outlineWidth={0.03}
              outlineColor="#1a0006"
            >
              {text}
            </Label>
          </KeepSize>
        );
      })}
    </>
  );
}
