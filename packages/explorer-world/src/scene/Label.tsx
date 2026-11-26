import { Billboard, Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { Vector3, type Group } from "three";
import { FONT, FONT_BOLD, FONT_MONO } from "./fonts.ts";

/**
 * Keeps text inside the glyphs of the bundled fonts. A glyph the font lacks
 * would make troika fetch a fallback font from the network.
 */
export function glyphSafe(text: string): string {
  let out = "";
  for (const c of text.replace(/→/g, "->")) {
    const code = c.codePointAt(0)!;
    if (code >= 0x2080 && code <= 0x2089) out += String(code - 0x2080);
    else if (code <= 0xff || (code >= 0x2000 && code <= 0x206f)) out += c;
    else out += "?";
  }
  return out;
}

type TextProps = Omit<ComponentProps<typeof Text>, "font" | "children"> & {
  children: string;
  weight?: "regular" | "bold" | "mono";
  billboard?: boolean;
  /**
   * Grow with distance so the text keeps a readable size on screen: the
   * distance at which it has its nominal size, and the largest factor.
   */
  keepSize?: [distance: number, max: number, min?: number];
};

const world = new Vector3();

export function Label({
  children,
  weight = "regular",
  billboard = false,
  position,
  keepSize,
  ...props
}: TextProps) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g || !keepSize) return;
    g.getWorldPosition(world);
    const k = camera.position.distanceTo(world) / keepSize[0];
    g.scale.setScalar(Math.min(keepSize[1], Math.max(keepSize[2] ?? 1, k)));
  });
  const text = (
    <Text
      font={
        weight === "bold" ? FONT_BOLD : weight === "mono" ? FONT_MONO : FONT
      }
      anchorX="center"
      anchorY="middle"
      outlineWidth={props.outlineWidth ?? 0}
      position={billboard ? undefined : position}
      {...props}
    >
      {glyphSafe(children)}
    </Text>
  );
  const scaled = keepSize ? <group ref={group}>{text}</group> : text;
  return billboard ? (
    <Billboard position={position}>{scaled}</Billboard>
  ) : (
    scaled
  );
}

/** Grows its children with camera distance, like `keepSize` on a label. */
export function KeepSize({
  children,
  distance,
  max,
  position,
}: {
  children: ReactNode;
  distance: number;
  max: number;
  position?: [number, number, number];
}) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    g.getWorldPosition(world);
    g.scale.setScalar(
      Math.min(max, Math.max(1, camera.position.distanceTo(world) / distance)),
    );
  });
  return (
    <group ref={group} position={position}>
      {children}
    </group>
  );
}
