/**
 * Standard drawings of the parts, which a look configures with a `Style`
 * and overrides where it draws a part its own way. Everything here takes its
 * appearance from the style; it holds the shapes common to most looks.
 */
import { Edges, Line, Outlines, RoundedBox } from "@react-three/drei";
import type { ReactElement, ReactNode } from "react";
import { CatmullRomCurve3, type Vector3 } from "three";
import { Words, usePage } from "./kit.tsx";
import type {
  BlockProps,
  ContainerProps,
  ExitProps,
  LabelProps,
  MoverProps,
  PageStyle,
  Parts,
  PathProps,
  ScreenProps,
  TokenProps,
} from "./look.ts";
import type { Texture } from "three";

/** A material element, as JSX: `<meshStandardMaterial color="..." />`. */
type M = ReactElement;

export type Style = {
  page: PageStyle;
  /** The material that shows the page, given its texture. */
  pageMaterial: (map: Texture) => M;
  m: {
    frame: M;
    stand: M;
    block: M;
    blockActive: M;
    container: M;
    containerActive: M;
    exit: M;
    exitActive: M;
    portal: M;
    token: M;
    slot: M;
    request: M;
    response: M;
  };
  /** Rounding of boxes; 0 draws sharp boxes. */
  radius: number;
  /** Lines along the edges of solids, or none. */
  edges: { color: string; active: string; opacity?: number } | null;
  label: {
    color: string;
    note: string;
    weight: "regular" | "bold" | "mono";
    size: number;
    caps?: boolean;
    letterSpacing?: number;
    outline?: { color: string; width: number };
  };
  path: {
    color: string;
    active: string;
    width: number;
    opacity: number;
    /** Drawn relations (not travelled) are dashed. */
    dashRelations?: boolean;
    /** Every path is dashed. */
    dashed?: boolean;
    /** A tube of this radius in place of a line, with the materials. */
    tube?: { radius: number; m: M; active: M };
  };
  mover: { radius: number; segments?: number };
  /** The screen's frame around the page and the depth of its body. */
  screen: { bezel: number; depth: number };
  /** A drawn outline around each solid, as in a cartoon. */
  outline?: { color: string; thickness: number };
  /** Cast and receive shadows. */
  shadows?: boolean;
};

export function makeParts(s: Style, ground: () => ReactNode): Parts {
  const cast = !!s.shadows;

  const Solid = ({
    size,
    position,
    m,
    active,
    children,
  }: {
    size: [number, number, number];
    position: [number, number, number];
    m: M;
    active?: boolean;
    children?: ReactNode;
  }) =>
    s.radius > 0 ? (
      <RoundedBox
        args={size}
        radius={Math.min(s.radius, ...size.map((x) => x / 2.01))}
        smoothness={3}
        position={position}
        castShadow={cast}
        receiveShadow={cast}
      >
        {m}
        {s.outline && (
          <Outlines thickness={s.outline.thickness} color={s.outline.color} />
        )}
        {children}
      </RoundedBox>
    ) : (
      <mesh position={position} castShadow={cast} receiveShadow={cast}>
        <boxGeometry args={size} />
        {m}
        {s.edges && (
          <Edges
            threshold={20}
            color={active ? s.edges.active : s.edges.color}
            transparent={s.edges.opacity !== undefined}
            opacity={s.edges.opacity ?? 1}
          />
        )}
        {s.outline && (
          <Outlines thickness={s.outline.thickness} color={s.outline.color} />
        )}
        {children}
      </mesh>
    );

  const Label = ({ position, text, kind }: LabelProps) => (
    <Words
      position={position}
      fontSize={kind === "name" ? s.label.size : s.label.size * 0.6}
      color={kind === "name" ? s.label.color : s.label.note}
      weight={kind === "name" ? s.label.weight : "mono"}
      letterSpacing={s.label.letterSpacing ?? 0}
      outlineWidth={s.label.outline?.width ?? 0}
      outlineColor={s.label.outline?.color ?? "black"}
    >
      {s.label.caps ? text.toUpperCase() : text}
    </Words>
  );

  /** A name above the front edge of a thing. */
  const nameOf = (
    text: string,
    [x, , z]: [number, number, number],
    [, h, d]: [number, number, number],
  ) => (
    <Label
      position={[x, h + s.label.size * 0.95, z + d / 2]}
      text={text}
      kind="name"
    />
  );

  const Screen = ({
    position: [x, y, z],
    width,
    height,
    pressed,
  }: ScreenProps) => {
    const map = usePage(s.page, pressed);
    const b = s.screen.bezel;
    const d = s.screen.depth;
    return (
      <group position={[x, y, z]}>
        <Solid
          size={[width + 2 * b, height + 2 * b, d]}
          position={[0, height / 2, -d / 2]}
          m={s.m.frame}
        />
        <mesh position={[0, height / 2, 0.02]}>
          <planeGeometry args={[width, height]} />
          {s.pageMaterial(map)}
        </mesh>
        {/* Two legs down to the ground. */}
        {[-1, 1].map((side) => (
          <Solid
            key={side}
            size={[0.7, y + 0.2, 0.7]}
            position={[side * width * 0.32, -y / 2, -d / 2]}
            m={s.m.stand}
          />
        ))}
      </group>
    );
  };

  const Block = ({ position, size, label, active }: BlockProps) => (
    <group>
      <Solid
        size={size}
        position={[position[0], size[1] / 2, position[2]]}
        m={active ? s.m.blockActive : s.m.block}
        active={active}
      />
      {nameOf(label, position, size)}
    </group>
  );

  /** An open tray: a floor and four low walls. */
  const Container = ({
    position,
    size,
    label,
    active,
    children,
  }: ContainerProps) => {
    const [x, , z] = position;
    const [w, h, d] = size;
    const t = 0.22;
    const m = active ? s.m.containerActive : s.m.container;
    return (
      <group>
        <Solid
          size={[w, t, d]}
          position={[x, t / 2, z]}
          m={m}
          active={active}
        />
        <Solid
          size={[w, h, t]}
          position={[x, h / 2, z - d / 2 + t / 2]}
          m={m}
          active={active}
        />
        <Solid
          size={[w, h * 0.55, t]}
          position={[x, (h * 0.55) / 2, z + d / 2 - t / 2]}
          m={m}
          active={active}
        />
        {[-1, 1].map((side) => (
          <Solid
            key={side}
            size={[t, h, d - 2 * t]}
            position={[x + (side * (w - t)) / 2, h / 2, z]}
            m={m}
            active={active}
          />
        ))}
        {children}
        {/* Above what it holds, which stands taller than its walls. */}
        {nameOf(label, position, [w, Math.max(h, 1.5), d])}
      </group>
    );
  };

  /** A gate: two posts and a lintel, with the way out between them. */
  const Exit = ({
    position,
    width,
    height,
    rotationY,
    label,
    active,
  }: ExitProps) => {
    const post = 0.7;
    const m = active ? s.m.exitActive : s.m.exit;
    return (
      <group position={position} rotation={[0, rotationY, 0]}>
        {[-1, 1].map((side) => (
          <Solid
            key={side}
            size={[post, height, post]}
            position={[(side * (width + post)) / 2, height / 2, 0]}
            m={m}
            active={active}
          />
        ))}
        <Solid
          size={[width + 2 * post, post, post]}
          position={[0, height + post / 2, 0]}
          m={m}
          active={active}
        />
        <mesh position={[0, height / 2, -0.05]}>
          <planeGeometry args={[width, height]} />
          {s.m.portal}
        </mesh>
        <Label
          position={[0, height + post + s.label.size * 0.9, 0]}
          text={label}
          kind="name"
        />
      </group>
    );
  };

  /** A token: an upright card with its name. */
  const Token = ({ position, label, state }: TokenProps) => {
    const p = Array.isArray(position) ? position : position.toArray();
    const size: [number, number, number] = [2.5, 1.5, 0.2];
    if (state === "slot")
      return (
        <mesh position={[p[0], p[1] + size[1] / 2 - 0.25, p[2]]}>
          <planeGeometry args={[size[0], size[1]]} />
          {s.m.slot}
          {s.edges && (
            <Edges color={s.edges.color} transparent opacity={0.45} />
          )}
        </mesh>
      );
    return (
      <group position={[p[0], p[1] + size[1] / 2 - 0.25, p[2]]}>
        <Solid size={size} position={[0, 0, 0]} m={s.m.token} />
        <Words
          position={[0, 0, size[2] / 2 + 0.02]}
          fontSize={0.34}
          color={s.label.color}
          weight={s.label.weight === "mono" ? "mono" : "bold"}
          maxWidth={size[0] * 0.9}
          textAlign="center"
        >
          {s.label.caps ? label.toUpperCase() : label}
        </Words>
      </group>
    );
  };

  const Path = ({ points, active, travelled }: PathProps) => {
    const dashed = s.path.dashed || (!travelled && s.path.dashRelations);
    if (s.path.tube)
      return (
        <mesh castShadow={cast}>
          <tubeGeometry
            args={[
              new CatmullRomCurve3(points as Vector3[]),
              96,
              s.path.tube.radius,
              8,
              false,
            ]}
          />
          {active ? s.path.tube.active : s.path.tube.m}
        </mesh>
      );
    return (
      <Line
        points={points}
        color={active ? s.path.active : s.path.color}
        lineWidth={s.path.width * (active ? 1.6 : 1)}
        transparent
        opacity={active ? 1 : s.path.opacity}
        dashed={dashed}
        dashSize={0.5}
        gapSize={0.35}
        depthWrite={false}
      />
    );
  };

  const Mover = ({ position, kind, opacity }: MoverProps) => (
    <mesh position={position} castShadow={cast} visible={opacity > 0.02}>
      <sphereGeometry
        args={[s.mover.radius, s.mover.segments ?? 32, s.mover.segments ?? 24]}
      />
      {kind === "request" ? s.m.request : s.m.response}
    </mesh>
  );

  const Ground = () => <>{ground()}</>;

  return { Ground, Screen, Block, Container, Exit, Token, Path, Mover, Label };
}
