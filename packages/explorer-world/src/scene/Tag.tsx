import { Html } from "@react-three/drei";
import type { ReactNode } from "react";

/**
 * A caption that keeps one size on screen whatever the distance: for what
 * moves or happens (a traveller, a warning), which must read from anywhere.
 */
export function Tag({
  position,
  color,
  children,
}: {
  position?: [number, number, number];
  color?: string;
  children: ReactNode;
}) {
  return (
    <Html
      position={position}
      center
      zIndexRange={[20, 0]}
      style={{ pointerEvents: "none" }}
    >
      <div className="tag" style={{ color }}>
        {children}
      </div>
    </Html>
  );
}
