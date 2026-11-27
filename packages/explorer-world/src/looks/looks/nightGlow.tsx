/**
 * Night glow: the current world's look, tidied. A dark navy night, dark
 * solids traced by cool glowing edges, light lines between them, and a warm
 * light that travels. Bloom, after the sanitize pass.
 */
import {
  Bloom,
  EffectComposer,
  Vignette,
  ToneMapping,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useMemo } from "react";
import { ACESFilmicToneMapping } from "three";
import { makeParts } from "../base.tsx";
import { GradientSky } from "../kit.tsx";
import type { Look } from "../look.ts";
import { SanitizePass } from "../../scene/safety.ts";

const BG = "#070b18";

const page = {
  background: "#0e1528",
  text: "#e6ecff",
  muted: "#8a96b8",
  field: "#151e36",
  fieldBorder: "#33416a",
  button: "#3a6df0",
  buttonText: "#ffffff",
  buttonPressed: "#ffb547",
  link: "#7fb2ff",
  font: "Inter",
};

const solid = (c: string, e = "#000000") => (
  <meshStandardMaterial
    color={c}
    emissive={e}
    roughness={0.7}
    metalness={0.1}
  />
);

export const nightGlow: Look = {
  id: "night-glow",
  name: "Night glow",
  summary:
    "The current world, tidied: dark navy night, solids traced by glowing edges, a warm light travelling.",
  chrome: "dark",
  gl: { toneMapping: ACESFilmicToneMapping, exposure: 1, shadows: false },
  page,
  Stage: () => (
    <>
      <GradientSky top="#0c1430" bottom={BG} />
      <fog attach="fog" args={[BG, 50, 150]} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#5a78c8", "#05070f", 0.6]} />
      <directionalLight
        position={[-10, 20, 15]}
        intensity={0.5}
        color="#9fb4ff"
      />
    </>
  ),
  Effects: () => {
    const pass = useMemo(() => new SanitizePass(), []);
    return (
      <EffectComposer multisampling={4}>
        <primitive object={pass} />
        <Bloom
          mipmapBlur
          intensity={0.85}
          luminanceThreshold={0.6}
          luminanceSmoothing={0.25}
          radius={0.7}
        />
        <Vignette offset={0.3} darkness={0.7} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    );
  },
  parts: makeParts(
    {
      page,
      pageMaterial: (map) => (
        <meshBasicMaterial map={map} toneMapped={false} color="#d8deee" />
      ),
      m: {
        frame: solid("#0d1322"),
        stand: solid("#0d1322"),
        block: solid("#111a30"),
        blockActive: solid("#16244a", "#0a1a44"),
        container: solid("#111a30"),
        containerActive: solid("#16244a", "#0a1a44"),
        exit: solid("#111a30"),
        exitActive: solid("#1c2a54", "#1a2a66"),
        portal: (
          <meshBasicMaterial
            color="#5ad1ff"
            transparent
            opacity={0.16}
            toneMapped={false}
          />
        ),
        token: solid("#1a2a50", "#122a66"),
        slot: (
          <meshBasicMaterial
            color="#5ad1ff"
            transparent
            opacity={0.05}
            depthWrite={false}
          />
        ),
        request: (
          <meshBasicMaterial color={[2.2, 1.4, 0.5]} toneMapped={false} />
        ),
        response: (
          <meshBasicMaterial color={[0.6, 2.0, 1.5]} toneMapped={false} />
        ),
      },
      radius: 0,
      edges: { color: "#4fb8ff", active: "#c8f0ff" },
      label: { color: "#dfe8ff", note: "#8a96b8", weight: "bold", size: 0.8 },
      path: {
        color: "#3c6aa8",
        active: "#9fe6ff",
        width: 2,
        opacity: 0.75,
        dashRelations: true,
      },
      mover: { radius: 0.45 },
      screen: { bezel: 0.35, depth: 0.5 },
    },
    () => (
      <>
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.01, 0]}>
          <circleGeometry args={[200, 64]} />
          <meshStandardMaterial color="#0a1124" roughness={1} />
        </mesh>
        <gridHelper
          args={[120, 30, "#16244a", "#101a36"]}
          position={[0, 0.005, 0]}
        />
      </>
    ),
  ),
};
