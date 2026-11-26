import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, MathUtils, type Group, type MeshStandardMaterial } from "three";
import type { FunctionDef } from "../model/types.ts";
import { currentState, hover, usePlayback } from "../store.ts";
import { Label } from "./Label.tsx";
import { FUNCTION_HEIGHT, type NodeLayout } from "./layout.ts";
import { Lod } from "./Lod.tsx";
import { REGION_COLORS, TONE_COLORS } from "./palette.ts";

/**
 * A function: a crystal pillar. A mutation is a hexagonal prism, a query a
 * slender round one. Its core lights while the function runs.
 */
export function FunctionNode({
  fn,
  layout,
}: {
  fn: FunctionDef;
  layout: NodeLayout;
}) {
  const base = useMemo(
    () => new Color(REGION_COLORS[fn.region] ?? "#fff"),
    [fn.region],
  );
  const core = useRef<MeshStandardMaterial>(null);
  const shell = useRef<MeshStandardMaterial>(null);
  const ring = useRef<Group>(null);
  const glow = useRef(0);
  const tint = useMemo(() => new Color(), []);
  const select = usePlayback((s) => s.select);
  const selected = usePlayback(
    (s) => s.selected?.type === "function" && s.selected.id === fn.id,
  );
  const isQuery = fn.type === "query";
  const short = fn.name.replace(/^public\./, "").replace(/^auth:/, "");

  useFrame((_, delta) => {
    const state = currentState();
    const active = state.active.get(fn.id);
    glow.current = MathUtils.damp(glow.current, active ? 1 : 0, 6, delta);
    tint.copy(base);
    if (active && active.tone !== "normal") tint.set(TONE_COLORS[active.tone]);
    if (core.current) {
      core.current.emissive.copy(tint);
      core.current.emissiveIntensity = 1.1 + glow.current * 6;
    }
    if (shell.current)
      shell.current.emissiveIntensity =
        0.05 + glow.current * 0.35 + (selected ? 0.25 : 0);
    if (ring.current) {
      ring.current.rotation.y += delta * (0.3 + glow.current * 3);
      ring.current.position.y =
        FUNCTION_HEIGHT +
        0.3 +
        Math.sin(performance.now() / 600) * 0.05 * glow.current;
      ring.current.scale.setScalar(1 + glow.current * 0.25);
    }
  });

  return (
    <group
      position={layout.position}
      onClick={(e) => {
        e.stopPropagation();
        select({ type: "function", id: fn.id });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        hover.label = fn.name;
      }}
      onPointerOut={() => (hover.label = "")}
    >
      <mesh position={[0, FUNCTION_HEIGHT / 2, 0]}>
        <cylinderGeometry
          args={
            isQuery
              ? [0.32, 0.42, FUNCTION_HEIGHT, 24]
              : [0.55, 0.62, FUNCTION_HEIGHT, 6]
          }
        />
        <meshStandardMaterial
          ref={shell}
          color="#101830"
          emissive={base}
          emissiveIntensity={0.05}
          metalness={0.3}
          roughness={0.15}
          transparent
          opacity={0.82}
        />
      </mesh>
      <mesh position={[0, FUNCTION_HEIGHT / 2, 0]}>
        <cylinderGeometry
          args={
            isQuery
              ? [0.1, 0.12, FUNCTION_HEIGHT * 0.92, 12]
              : [0.18, 0.2, FUNCTION_HEIGHT * 0.92, 6]
          }
        />
        <meshStandardMaterial
          ref={core}
          color="#000"
          emissive={base}
          emissiveIntensity={0.5}
          toneMapped={false}
        />
      </mesh>
      <group ref={ring} position={[0, FUNCTION_HEIGHT + 0.3, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry
            args={[isQuery ? 0.45 : 0.7, 0.03, 6, isQuery ? 32 : 6]}
          />
          <meshStandardMaterial
            color={base}
            emissive={base}
            emissiveIntensity={1.2}
            toneMapped={false}
          />
        </mesh>
      </group>
      {fn.scheduled && (
        <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.85, 0.95, 48, 1, 0, Math.PI * 1.6]} />
          <meshStandardMaterial
            color={base}
            emissive={base}
            emissiveIntensity={1}
            toneMapped={false}
          />
        </mesh>
      )}
      <Lod far={46}>
        <Label
          billboard
          position={[0, FUNCTION_HEIGHT + 1.15, 0]}
          fontSize={0.42}
          color="#e8eeff"
          outlineWidth={0.03}
          outlineColor="#03050a"
        >
          {short}
        </Label>
      </Lod>
      <Lod far={24}>
        <Label
          billboard
          position={[0, FUNCTION_HEIGHT + 0.72, 0]}
          fontSize={0.26}
          color="#8d9abb"
          letterSpacing={0.1}
        >
          {`${fn.visibility} ${fn.type}${fn.scheduled ? " · scheduled" : ""}`.toUpperCase()}
        </Label>
      </Lod>
    </group>
  );
}
