/**
 * Studio model: a matte white architectural model on a pale ground, lit by
 * a soft sky and one sun with soft shadows. Everything is the same white;
 * only what moves, and the path it is on, takes the one accent colour.
 */
import { ACESFilmicToneMapping } from "three";
import { makeParts } from "../base.tsx";
import { GradientSky } from "../kit.tsx";
import type { Look } from "../look.ts";

const ACCENT = "#ff5a1f";
const GROUND = "#e7e4de";

const page = {
  background: "#f4f3f0",
  text: "#34322e",
  muted: "#8d8a83",
  field: "#ffffff",
  fieldBorder: "#c9c6bf",
  button: "#4a4844",
  buttonText: "#ffffff",
  buttonPressed: ACCENT,
  link: "#4a4844",
  font: "Inter",
};

const matte = (c = "#f6f5f2") => (
  <meshStandardMaterial color={c} roughness={0.95} metalness={0} />
);

export const studio: Look = {
  id: "studio",
  name: "Studio model",
  summary:
    "A matte white architectural model on a pale ground, soft sun and shadows; the one accent colour is kept for what moves.",
  chrome: "light",
  gl: { toneMapping: ACESFilmicToneMapping, exposure: 1.05, shadows: true },
  page,
  Stage: () => (
    <>
      <GradientSky top="#f3f2ef" bottom="#dedad3" />
      <fog attach="fog" args={[GROUND, 70, 170]} />
      <hemisphereLight args={["#ffffff", "#cfc9bf", 1.2]} />
      <directionalLight
        position={[-14, 26, 18]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-camera-far={90}
        shadow-radius={6}
        shadow-bias={-0.0004}
      />
    </>
  ),
  Effects: null,
  parts: makeParts(
    {
      page,
      pageMaterial: (map) => (
        <meshStandardMaterial
          map={map}
          roughness={0.9}
          emissive="#ffffff"
          emissiveMap={map}
          emissiveIntensity={0.55}
        />
      ),
      m: {
        frame: matte(),
        stand: matte(),
        block: matte(),
        blockActive: matte(),
        container: matte(),
        containerActive: matte(),
        exit: matte(),
        exitActive: matte(),
        portal: <meshStandardMaterial color="#d9d5ce" roughness={1} />,
        token: matte("#ffffff"),
        slot: (
          <meshBasicMaterial
            color="#b9b4ab"
            transparent
            opacity={0.25}
            depthWrite={false}
          />
        ),
        request: <meshStandardMaterial color={ACCENT} roughness={0.6} />,
        response: <meshStandardMaterial color={ACCENT} roughness={0.6} />,
      },
      radius: 0.14,
      edges: null,
      label: {
        color: "#3b3934",
        note: "#8d8a83",
        weight: "bold",
        size: 0.75,
        letterSpacing: 0.01,
      },
      path: {
        color: "#a9a49a",
        active: ACCENT,
        width: 1.6,
        opacity: 0.9,
        dashRelations: true,
      },
      mover: { radius: 0.42 },
      screen: { bezel: 0.3, depth: 0.6 },
      shadows: true,
    },
    () => (
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[220, 64]} />
        <meshStandardMaterial color={GROUND} roughness={1} />
      </mesh>
    ),
  ),
};
