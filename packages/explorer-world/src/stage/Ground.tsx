import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  type LineBasicMaterial,
} from "three";
import { FOG, GRID, LOOK, MATTE } from "./look.ts";

/** The spacings of the grid on the ground, a decade apart: 10 m, 100 m, 1 km. */
const LEVELS = [10, 100, 1000];
/** Lines each way of one level. */
const LINES = 120;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function lines(spacing: number): BufferGeometry {
  const half = (LINES / 2) * spacing;
  const v: number[] = [];
  for (let i = -LINES / 2; i <= LINES / 2; i++) {
    const at = i * spacing;
    v.push(-half, 0, at, half, 0, at, at, 0, -half, at, 0, half);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(v, 3));
  return g;
}

/**
 * One level of the grid: its lines show while their spacing reads at the
 * camera's height, and fade out on either side, so that one level hands
 * over to the next as the camera rises or falls.
 */
function GridLevel({ spacing }: { spacing: number }) {
  const geometry = useMemo(() => lines(spacing), [spacing]);
  const material = useRef<LineBasicMaterial>(null);
  useFrame(({ camera }) => {
    const m = material.current;
    if (!m) return;
    const r = spacing / Math.max(camera.position.y, 0.5);
    m.opacity =
      GRID.opacity * smooth(0.006, 0.03, r) * (1 - smooth(0.6, 2.5, r));
    m.visible = m.opacity > 0.002;
  });
  return (
    <lineSegments geometry={geometry} position={[0, 0.03, 0]}>
      <lineBasicMaterial
        ref={material}
        color={GRID.color}
        transparent
        depthWrite={false}
      />
    </lineSegments>
  );
}

/** The ground, far in every direction, with its grid and a far horizon. */
export function Ground() {
  return (
    <group>
      <fog attach="fog" args={[LOOK.background, FOG.near, FOG.far]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[400_000, 400_000]} />
        <meshStandardMaterial color={LOOK.ground} {...MATTE} />
      </mesh>
      {LEVELS.map((s) => (
        <GridLevel key={s} spacing={s} />
      ))}
    </group>
  );
}
