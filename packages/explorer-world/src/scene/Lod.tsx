import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import { Material, Mesh, Object3D, Vector3, type Group } from "three";

const world = new Vector3();

/**
 * Shows its children only within a band of camera distances, fading at the
 * edges: the level of detail. `near` and `far` are where the fade completes.
 */
export function Lod({
  children,
  near = 0,
  far,
  fade = 0.25,
}: {
  children: ReactNode;
  near?: number;
  far: number;
  /** The fraction of each bound over which the children fade. */
  fade?: number;
}) {
  const group = useRef<Group>(null);
  const last = useRef(-1);

  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    g.getWorldPosition(world);
    const d = camera.position.distanceTo(world);
    let alpha = 1;
    if (d > far) alpha = 0;
    else if (d > far * (1 - fade)) alpha = (far - d) / (far * fade);
    if (near > 0) {
      if (d < near) alpha = 0;
      else if (d < near * (1 + fade)) alpha *= (d - near) / (near * fade);
    }
    const changed = Math.abs(alpha - last.current) > 0.005;
    last.current = alpha;
    g.visible = alpha > 0.01;
    if (!g.visible && !changed) return;
    // Walked every frame: troika text and new rows create materials late.
    g.traverse((o: Object3D) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      for (const material of Array.isArray(m) ? m : m ? [m] : []) {
        if (material.userData.baseOpacity === undefined) {
          material.userData.baseOpacity = material.opacity;
          material.transparent = true;
        }
        material.opacity = material.userData.baseOpacity * alpha;
      }
    });
  });

  return <group ref={group}>{children}</group>;
}
