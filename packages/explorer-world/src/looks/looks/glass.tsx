/**
 * Glass: frosted translucent slabs in a pale, softly lit space. Every
 * container shows what it holds through its walls; the tokens inside are the
 * only solid colour, and what moves is a small glowing bead.
 */
import { Environment, Lightformer } from "@react-three/drei";
import { ACESFilmicToneMapping } from "three";
import { makeParts } from "../base.tsx";
import { GradientSky } from "../kit.tsx";
import type { Look } from "../look.ts";

const ACCENT = "#3d6bff";

const page = {
  background: "#fbfcfe",
  text: "#1f2a3d",
  muted: "#7a879c",
  field: "#ffffff",
  fieldBorder: "#cfd7e3",
  button: "#1f2a3d",
  buttonText: "#ffffff",
  buttonPressed: ACCENT,
  link: ACCENT,
  font: "Inter",
};

const glass = (tint = "#f2f7ff", rough = 0.3) => (
  <meshPhysicalMaterial
    color={tint}
    transmission={0.94}
    roughness={rough}
    thickness={0.9}
    ior={1.35}
    metalness={0}
    clearcoat={0.4}
    clearcoatRoughness={0.3}
  />
);

export const glassLook: Look = {
  id: "glass",
  name: "Glass",
  summary:
    "Frosted translucent slabs in pale soft light: containers show what is inside them, the tokens are the only solid colour.",
  chrome: "light",
  gl: { toneMapping: ACESFilmicToneMapping, exposure: 1, shadows: true },
  page,
  Stage: () => (
    <>
      <GradientSky top="#e4ebf4" bottom="#c3cfde" />
      <fog attach="fog" args={["#ccd6e3", 70, 170]} />
      <hemisphereLight args={["#ffffff", "#c6d0de", 0.9]} />
      <directionalLight
        position={[8, 24, 16]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-radius={8}
        shadow-bias={-0.0004}
      />
      <Environment resolution={128} frames={1}>
        <Lightformer
          form="rect"
          intensity={2.4}
          position={[0, 12, 6]}
          rotation-x={Math.PI / 2}
          scale={[40, 14, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.2}
          position={[-24, 6, 0]}
          rotation-y={Math.PI / 2}
          scale={[30, 8, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.2}
          position={[24, 6, 0]}
          rotation-y={-Math.PI / 2}
          scale={[30, 8, 1]}
        />
        <Lightformer
          form="rect"
          color="#cfe0ff"
          intensity={0.8}
          position={[0, 4, -30]}
          scale={[60, 10, 1]}
        />
      </Environment>
    </>
  ),
  Effects: null,
  parts: makeParts(
    {
      page,
      pageMaterial: (map) => (
        <meshBasicMaterial map={map} toneMapped={false} color="#f0f3f8" />
      ),
      m: {
        frame: glass("#eef4ff", 0.18),
        stand: glass("#eef4ff", 0.18),
        block: glass(),
        blockActive: glass("#dfe8ff", 0.2),
        container: glass(),
        containerActive: glass("#dfe8ff", 0.2),
        exit: glass(),
        exitActive: glass("#dfe8ff", 0.2),
        portal: (
          <meshBasicMaterial
            color={ACCENT}
            transparent
            opacity={0.08}
            depthWrite={false}
          />
        ),
        token: <meshStandardMaterial color={ACCENT} roughness={0.35} />,
        slot: (
          <meshBasicMaterial
            color={ACCENT}
            transparent
            opacity={0.08}
            depthWrite={false}
          />
        ),
        request: (
          <meshStandardMaterial
            color={ACCENT}
            emissive={ACCENT}
            emissiveIntensity={0.6}
            roughness={0.2}
          />
        ),
        response: (
          <meshStandardMaterial
            color="#7a4dff"
            emissive="#7a4dff"
            emissiveIntensity={0.6}
            roughness={0.2}
          />
        ),
      },
      radius: 0.3,
      edges: null,
      label: {
        color: "#22304a",
        note: "#6b7890",
        weight: "regular",
        size: 0.78,
      },
      path: { color: "#9fb0c8", active: ACCENT, width: 1.8, opacity: 0.8 },
      mover: { radius: 0.4 },
      screen: { bezel: 0.45, depth: 0.7 },
      shadows: true,
    },
    () => (
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[220, 64]} />
        <meshStandardMaterial color="#d3dce8" roughness={0.9} />
      </mesh>
    ),
  ),
};
