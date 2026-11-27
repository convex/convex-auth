/**
 * Blueprint: a technical line drawing on deep blue. No fills: every solid is
 * the colour of the paper, so only its edges show and hidden lines are
 * hidden. Monospaced capitals, a drafting grid, and a marker in yellow ink
 * for what moves. No light, no effects.
 */
import { Line } from "@react-three/drei";
import { NoToneMapping } from "three";
import { makeParts } from "../base.tsx";
import { Words } from "../kit.tsx";
import type { Look, MoverProps } from "../look.ts";

const PAPER = "#0f3d73";
const INK = "#e8f1ff";
const MARK = "#ffd34d";

const page = {
  background: PAPER,
  text: INK,
  muted: "#9dbbe3",
  field: PAPER,
  fieldBorder: INK,
  button: INK,
  buttonText: INK,
  buttonPressed: MARK,
  link: MARK,
  font: "'JetBrains Mono'",
  linesOnly: true,
  stroke: 3,
  caps: true,
};

const fill = (
  <meshBasicMaterial
    color={PAPER}
    toneMapped={false}
    polygonOffset
    polygonOffsetFactor={1}
    polygonOffsetUnits={1}
  />
);

const parts = makeParts(
  {
    page,
    pageMaterial: (map) => <meshBasicMaterial map={map} toneMapped={false} />,
    m: {
      frame: fill,
      stand: fill,
      block: fill,
      blockActive: fill,
      container: fill,
      containerActive: fill,
      exit: fill,
      exitActive: fill,
      portal: (
        <meshBasicMaterial
          color={PAPER}
          transparent
          opacity={0}
          depthWrite={false}
        />
      ),
      token: fill,
      slot: (
        <meshBasicMaterial
          color={PAPER}
          transparent
          opacity={0}
          depthWrite={false}
        />
      ),
      request: <meshBasicMaterial color={MARK} toneMapped={false} />,
      response: <meshBasicMaterial color={MARK} toneMapped={false} />,
    },
    radius: 0,
    edges: { color: INK, active: MARK },
    label: {
      color: INK,
      note: "#9dbbe3",
      weight: "mono",
      size: 0.68,
      caps: true,
      letterSpacing: 0.08,
    },
    path: {
      color: "#9dbbe3",
      active: MARK,
      width: 1.2,
      opacity: 0.9,
      dashRelations: true,
    },
    mover: { radius: 0.3 },
    screen: { bezel: 0.25, depth: 0.4 },
  },
  () => (
    <>
      <gridHelper args={[160, 80, "#2d5f9c", "#1d4c86"]} />
      <gridHelper
        args={[160, 16, "#3f74b4", "#3f74b4"]}
        position={[0, 0.01, 0]}
      />
    </>
  ),
);

/** A drafting marker: a ring with a cross through it, and what it is. */
function Marker({ position, kind, opacity }: MoverProps) {
  if (opacity < 0.02) return null;
  const r = 0.55;
  const ring = Array.from({ length: 41 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r, 0] as [number, number, number];
  });
  return (
    <group position={position}>
      <Line points={ring} color={MARK} lineWidth={2} />
      <Line
        points={[
          [-r * 1.6, 0, 0],
          [r * 1.6, 0, 0],
        ]}
        color={MARK}
        lineWidth={1}
      />
      <Line
        points={[
          [0, -r * 1.6, 0],
          [0, r * 1.6, 0],
        ]}
        color={MARK}
        lineWidth={1}
      />
      <Words
        position={[r * 1.9, r * 1.2, 0]}
        fontSize={0.42}
        color={MARK}
        weight="mono"
        anchorX="left"
      >
        {kind === "request" ? "REQ: SIGN IN" : "RES: 2 TOKENS"}
      </Words>
    </group>
  );
}

export const blueprint: Look = {
  id: "blueprint",
  name: "Blueprint",
  summary:
    "A line drawing on deep blue: no fills, hidden lines removed, drafting grid, monospaced capitals, a yellow marker for what moves.",
  chrome: "dark",
  gl: { toneMapping: NoToneMapping, exposure: 1, shadows: false },
  page,
  Stage: () => (
    <>
      <color attach="background" args={[PAPER]} />
      <fog attach="fog" args={[PAPER, 60, 140]} />
    </>
  ),
  Effects: null,
  parts: { ...parts, Mover: Marker },
};
