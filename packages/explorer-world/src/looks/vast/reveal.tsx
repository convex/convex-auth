/**
 * Detail by distance: a thing's insides grow in as the camera comes near the
 * thing, and shrink away as it leaves, so that no level is crowded. The
 * scale is a function of where the camera is, nothing else: nothing moves
 * by itself.
 */
import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import { Box3, Vector3, type Group } from "three";
import type { V3 } from "../layout.ts";

const smooth = (x: number) => x * x * (3 - 2 * x);

/** How far a box is from a point; 0 inside it. */
export function boxDistance(box: Box3, p: Vector3): number {
  return box.distanceToPoint(p);
}

/**
 * Children drawn about `at` (local coordinates), at full height when the
 * camera is within `full` metres of `box`, gone beyond `from`. `scale`
 * multiplies it (a key that does not exist yet has 0).
 */
export function Reveal({
  at,
  box,
  from,
  full,
  scale = 1,
  children,
}: {
  at: V3;
  box: [V3, V3];
  from: number;
  full: number;
  scale?: number;
  children: ReactNode;
}) {
  const group = useRef<Group>(null);
  const b = useRef(new Box3(new Vector3(...box[0]), new Vector3(...box[1])));
  b.current.min.set(...box[0]);
  b.current.max.set(...box[1]);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    const d = boxDistance(b.current, camera.position);
    const s = smooth(Math.min(1, Math.max(0, (from - d) / (from - full))));
    const k = s * scale;
    g.visible = k > 0.003;
    // It rises out of the surface it stands on.
    const across = 0.85 + 0.15 * k;
    g.scale.set(across, Math.max(k, 1e-3), across);
  });
  return (
    <group ref={group} position={at}>
      {children}
    </group>
  );
}
