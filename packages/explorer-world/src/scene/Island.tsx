import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MathUtils,
  type Mesh,
  type MeshStandardMaterial,
  type PointLight,
  ShaderMaterial,
} from "three";
import type { Region } from "../model/types.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { Label } from "./Label.tsx";
import type { IslandLayout } from "./layout.ts";
import { Lod } from "./Lod.tsx";
import { regionColorOf } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";

const wallVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const wallFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.6);
    float lines = smoothstep(0.6, 1.0, sin(vUv.x * 240.0) * 0.5 + 0.5) * 0.25;
    float sweep = smoothstep(0.92, 1.0, sin(vUv.x * 6.2831853 - uTime * 0.6) * 0.5 + 0.5);
    gl_FragColor = vec4(uColor, fade * (0.07 + lines * 0.08 + sweep * 0.06 + uGlow * 0.32));
  }
`;

/** The functions and tables of a region, for its glow. */
function regionNodes(id: string): string[] {
  return world.structure.functions
    .filter((f) => f.region === id)
    .map((f) => f.id);
}

export function Island({
  region,
  layout,
}: {
  region: Region;
  layout: IslandLayout;
}) {
  const color = useMemo(() => new Color(regionColorOf(region.id)), [region.id]);
  const rim = useRef<MeshStandardMaterial>(null);
  const wall = useRef<ShaderMaterial>(null);
  const light = useRef<PointLight>(null);
  const shock = useRef<Mesh>(null);
  const glow = useRef(0);
  const nodes = useMemo(() => regionNodes(region.id), [region.id]);
  const select = usePlayback((s) => s.select);
  const selected = usePlayback(
    (s) => s.selected?.type === "region" && s.selected.id === region.id,
  );
  const uniforms = useMemo(
    () => ({
      uColor: { value: color },
      uGlow: { value: 0 },
      uTime: { value: 0 },
    }),
    [color],
  );
  const { center, radius } = layout;
  const alarmColor = useMemo(() => new Color(TONE_COLORS.error), []);

  useFrame(({ clock }, delta) => {
    const state = currentState();
    const busy = nodes.some((n) => state.active.has(n));
    const alert = state.alerts.find((a) => a.region === region.id);
    const target = alert ? 1.6 : busy ? 1 : selected ? 0.6 : 0;
    glow.current = MathUtils.damp(glow.current, target, 4, delta);
    if (wall.current) {
      wall.current.uniforms.uGlow.value = glow.current;
      wall.current.uniforms.uTime.value = clock.elapsedTime;
      wall.current.uniforms.uColor.value = alert ? alarmColor : color;
    }
    if (rim.current) rim.current.emissiveIntensity = 1.4 + glow.current * 2.5;
    if (light.current) {
      light.current.intensity = 6 + glow.current * 40;
      light.current.color = alert ? alarmColor : color;
    }
    if (shock.current) {
      shock.current.visible = Boolean(alert);
      if (alert) {
        const phase = ((state.time - alert.start) * 0.7) % 1;
        shock.current.scale.setScalar(1 + phase * 0.45);
        (shock.current.material as MeshStandardMaterial).opacity =
          (1 - phase) * 0.9;
      }
    }
  });

  const pick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    select({ type: "region", id: region.id });
  };

  return (
    <group position={center}>
      {/* The body: a floating plinth with a dark glassy top. */}
      <mesh
        position={[0, -1.6, 0]}
        onClick={pick}
        onPointerOver={() => (hover.label = region.label)}
        onPointerOut={() => (hover.label = "")}
      >
        <cylinderGeometry args={[radius, radius * 0.62, 3.2, 64, 1]} />
        <meshStandardMaterial
          color="#0a0e1a"
          metalness={0.7}
          roughness={0.42}
        />
      </mesh>
      <mesh
        position={[0, 0.01, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={pick}
      >
        <circleGeometry args={[radius - 0.25, 64]} />
        <meshStandardMaterial
          color="#0d1324"
          metalness={0.85}
          roughness={0.25}
        />
      </mesh>
      {/* Rim of light: the edge of the trust boundary. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <torusGeometry args={[radius - 0.12, 0.09, 12, 128]} />
        <meshStandardMaterial
          ref={rim}
          color={color}
          emissive={color}
          emissiveIntensity={1.4}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.2, 0]}>
        <torusGeometry args={[radius * 0.62, 0.05, 8, 96]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.8}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 1.6, 0]} raycast={() => null}>
        <cylinderGeometry args={[radius, radius, 3.2, 96, 1, true]} />
        <shaderMaterial
          ref={wall}
          vertexShader={wallVertex}
          fragmentShader={wallFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
        />
      </mesh>
      {/* A shock ring for alerts, such as a revoked session. */}
      <mesh
        ref={shock}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.3, 0]}
        visible={false}
        raycast={() => null}
      >
        <ringGeometry args={[radius * 0.98, radius * 1.04, 96]} />
        <meshStandardMaterial
          color={TONE_COLORS.error}
          emissive={TONE_COLORS.error}
          emissiveIntensity={3}
          transparent
          toneMapped={false}
          side={DoubleSide}
        />
      </mesh>
      <pointLight
        ref={light}
        position={[0, 6, 0]}
        distance={radius * 3}
        decay={1.6}
        color={color}
      />

      {/* Far: the name of the region, large. Near: it steps aside. */}
      <Lod far={400} near={radius * 2.4}>
        <Label
          billboard
          keepSize={[80, 1.3, 0.45]}
          position={[0, -0.9, radius + 0.6]}
          fontSize={1.5 + radius * 0.06}
          color={color}
          weight="bold"
          letterSpacing={0.06}
          outlineWidth={0.04}
          outlineColor="#03050a"
        >
          {region.label}
        </Label>
      </Lod>
      <Lod far={110} near={radius * 2.4}>
        <Label
          billboard
          keepSize={[80, 1.3, 0.45]}
          position={[0, -2.9, radius + 0.6]}
          fontSize={0.5}
          color="#9aa6c4"
          letterSpacing={0.12}
        >
          {[region.tag ?? region.kind, region.package]
            .filter(Boolean)
            .join(" · ")
            .toUpperCase()}
        </Label>
      </Lod>
    </group>
  );
}
