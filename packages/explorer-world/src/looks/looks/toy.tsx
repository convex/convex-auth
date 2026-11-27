/**
 * Toy diorama: chunky shapes in flat saturated colours with dark outlines,
 * on a grass-green board under warm daylight, seen through a shallow depth of
 * field as if photographed close.
 */
import {
  DepthOfField,
  EffectComposer,
  ToneMapping,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useMemo } from "react";
import { NeutralToneMapping } from "three";
import { makeParts } from "../base.tsx";
import { GradientSky } from "../kit.tsx";
import type { BlockProps, ContainerProps, ExitProps, Look } from "../look.ts";
import { SanitizePass } from "../../scene/safety.ts";

const INK = "#2b2118";
/** The colours things take, by a hash of their name. */
const PAINT = ["#ff6b4a", "#2f8cff", "#ffc23d", "#8e5bff", "#16b388"];
const paint = (name: string) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PAINT[h % PAINT.length];
};
const toon = (c: string) => <meshLambertMaterial color={c} flatShading />;

const page = {
  background: "#fff6e6",
  text: INK,
  muted: "#7a6650",
  field: "#ffffff",
  fieldBorder: INK,
  button: "#ff6b4a",
  buttonText: "#ffffff",
  buttonPressed: "#ffc23d",
  link: "#2f8cff",
  font: "Inter",
  stroke: 6,
};

const style = {
  page,
  pageMaterial: (map: import("three").Texture) => (
    <meshBasicMaterial map={map} toneMapped={false} color="#f4ecdd" />
  ),
  m: {
    frame: toon("#ffc23d"),
    stand: toon("#ffc23d"),
    block: toon("#ffffff"),
    blockActive: toon("#ffffff"),
    container: toon("#ffffff"),
    containerActive: toon("#ffffff"),
    exit: toon("#16b388"),
    exitActive: toon("#3fd6a6"),
    portal: <meshLambertMaterial color="#1a5f4a" />,
    token: toon("#ffffff"),
    slot: (
      <meshBasicMaterial
        color={INK}
        transparent
        opacity={0.12}
        depthWrite={false}
      />
    ),
    request: toon("#ff3d6e"),
    response: toon("#ffc23d"),
  },
  radius: 0.28,
  edges: null,
  outline: { color: INK, thickness: 0.07 },
  label: {
    color: INK,
    note: "#7a6650",
    weight: "bold" as const,
    size: 0.85,
    outline: { color: "#fff6e6", width: 0.06 },
  },
  path: {
    color: "#fff6e6",
    active: "#ff3d6e",
    width: 3,
    opacity: 1,
    tube: {
      radius: 0.16,
      m: toon("#fff1d6"),
      active: toon("#ff3d6e"),
    },
  },
  mover: { radius: 0.6, segments: 6 },
  screen: { bezel: 0.6, depth: 0.9 },
  shadows: true,
};

/** The standard parts, each painted by its name. */
function painted() {
  const byColour = new Map<string, ReturnType<typeof makeParts>>();
  const partsFor = (name: string) => {
    const c = paint(name);
    let p = byColour.get(c);
    if (!p) {
      p = makeParts(
        {
          ...style,
          m: {
            ...style.m,
            block: toon(c),
            blockActive: toon(c),
            container: toon(c),
            containerActive: toon(c),
          },
        },
        ground,
      );
      byColour.set(c, p);
    }
    return p;
  };
  const base = makeParts(style, ground);
  return {
    ...base,
    Block: (p: BlockProps) => {
      const { Block } = partsFor(p.label);
      return <Block {...p} />;
    },
    Container: (p: ContainerProps) => {
      const { Container } = partsFor(p.label);
      return <Container {...p} />;
    },
    Exit: (p: ExitProps) => <base.Exit {...p} />,
  };
}

function ground() {
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} receiveShadow position={[0, -0.6, 2]}>
        <circleGeometry args={[220, 48]} />
        <meshLambertMaterial color="#cfe8b0" />
      </mesh>
      {/* The board the diorama stands on. */}
      <mesh receiveShadow position={[1.5, -0.3, -1]}>
        <boxGeometry args={[42, 0.6, 26]} />
        <meshLambertMaterial color="#7ccf5b" />
      </mesh>
    </>
  );
}

export const toy: Look = {
  id: "toy",
  name: "Toy diorama",
  summary:
    "Chunky outlined shapes in flat saturated colours on a green board, warm daylight, hard shadows and a shallow depth of field.",
  chrome: "light",
  gl: { toneMapping: NeutralToneMapping, exposure: 1.1, shadows: true },
  page,
  Stage: () => (
    <>
      <GradientSky top="#8fd0ff" bottom="#fff1d6" />
      <fog attach="fog" args={["#fbe9c8", 80, 190]} />
      <hemisphereLight args={["#fff4dc", "#7ccf5b", 1.1]} />
      <directionalLight
        position={[-18, 22, 14]}
        intensity={2.2}
        color="#ffe2b0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0005}
      />
    </>
  ),
  Effects: () => {
    const pass = useMemo(() => new SanitizePass(), []);
    return (
      <EffectComposer multisampling={4}>
        <primitive object={pass} />
        <DepthOfField
          worldFocusDistance={32}
          worldFocusRange={30}
          bokehScale={2.5}
        />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      </EffectComposer>
    );
  },
  parts: painted(),
};
