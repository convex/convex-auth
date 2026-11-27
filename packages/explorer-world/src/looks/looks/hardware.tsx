/**
 * Hardware: the browser as physical equipment in a dark studio. Brushed
 * metal units with engraved plates and indicator lights, black cables
 * between them, a monitor for the screen, and an amber bead of light that
 * travels the cables. Bloom only for the lights, after the sanitize pass.
 */
import { Environment, Lightformer, RoundedBox } from "@react-three/drei";
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
import { Words } from "../kit.tsx";
import type { V3 } from "../layout.ts";
import type { BlockProps, ContainerProps, ExitProps, Look } from "../look.ts";
import { SanitizePass } from "../../scene/safety.ts";

const AMBER = "#ffae3d";

const page = {
  background: "#f2f3f5",
  text: "#1d1f23",
  muted: "#6c7079",
  field: "#ffffff",
  fieldBorder: "#c4c8cf",
  button: "#1d1f23",
  buttonText: "#ffffff",
  buttonPressed: AMBER,
  link: "#1d1f23",
  font: "Inter",
};

const metal = (c = "#9aa0a8", rough = 0.38) => (
  <meshStandardMaterial color={c} metalness={0.9} roughness={rough} />
);
const rubber = (
  <meshStandardMaterial color="#141518" roughness={0.75} metalness={0} />
);
const led = (on: boolean, c = "#4dff7a") =>
  on ? (
    <meshBasicMaterial color={c} toneMapped={false} />
  ) : (
    <meshStandardMaterial color="#2a2c30" roughness={0.4} />
  );

const parts = makeParts(
  {
    page,
    pageMaterial: (map) => (
      <meshBasicMaterial map={map} toneMapped={false} color="#c9ccd2" />
    ),
    m: {
      frame: (
        <meshStandardMaterial
          color="#0c0d0f"
          roughness={0.35}
          metalness={0.3}
        />
      ),
      stand: metal("#5d6168"),
      block: metal(),
      blockActive: metal(),
      container: metal("#7d838b", 0.45),
      containerActive: metal("#7d838b", 0.45),
      exit: metal("#5d6168"),
      exitActive: metal("#5d6168"),
      portal: <meshBasicMaterial color="#050506" />,
      token: (
        <meshStandardMaterial color="#d9c48e" metalness={0.7} roughness={0.3} />
      ),
      slot: (
        <meshBasicMaterial
          color="#000000"
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      ),
      request: (
        <meshBasicMaterial color={[2.4, 1.3, 0.35]} toneMapped={false} />
      ),
      response: (
        <meshBasicMaterial color={[2.4, 1.3, 0.35]} toneMapped={false} />
      ),
    },
    radius: 0.06,
    edges: null,
    label: {
      color: "#d6d9de",
      note: "#8d929b",
      weight: "mono",
      size: 0.62,
      caps: true,
      letterSpacing: 0.06,
    },
    path: {
      color: "#222",
      active: AMBER,
      width: 2,
      opacity: 1,
      tube: {
        radius: 0.14,
        m: rubber,
        active: (
          <meshStandardMaterial
            color="#1b1712"
            emissive="#4a2a00"
            roughness={0.7}
          />
        ),
      },
    },
    mover: { radius: 0.32 },
    screen: { bezel: 0.7, depth: 1.1 },
    shadows: true,
  },
  () => (
    <>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[220, 64]} />
        <meshStandardMaterial
          color="#1d1e22"
          roughness={0.85}
          metalness={0.1}
        />
      </mesh>
    </>
  ),
);

/** An engraved plate on the front of a unit, and its row of lights. */
function Front({
  position: [x, , z],
  size: [w, h, d],
  label,
  lit,
}: {
  position: V3;
  size: V3;
  label: string;
  lit: boolean;
}) {
  const face = z + d / 2 + 0.01;
  return (
    <group>
      <RoundedBox
        args={[w * 0.62, h * 0.42, 0.06]}
        radius={0.03}
        position={[x - w * 0.12, h * 0.55, face]}
      >
        <meshStandardMaterial color="#1a1c20" roughness={0.5} metalness={0.4} />
      </RoundedBox>
      <Words
        position={[x - w * 0.12, h * 0.55, face + 0.05]}
        fontSize={0.4}
        color="#d6d9de"
        weight="mono"
        letterSpacing={0.06}
      >
        {label.toUpperCase()}
      </Words>
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          position={[x + w * 0.3 + i * 0.36, h * 0.55, face + 0.02]}
        >
          <circleGeometry args={[0.1, 16]} />
          {led(i === 0 ? true : lit, i === 0 ? "#4dff7a" : AMBER)}
        </mesh>
      ))}
    </group>
  );
}

function Unit(p: BlockProps) {
  const [x, , z] = p.position;
  const [w, h, d] = p.size;
  return (
    <group>
      <RoundedBox
        args={[w, h, d]}
        radius={0.06}
        position={[x, h / 2, z]}
        castShadow
        receiveShadow
      >
        {metal()}
      </RoundedBox>
      {/* Rack ears. */}
      {[-1, 1].map((s) => (
        <mesh
          key={s}
          position={[x + s * (w / 2 + 0.12), h / 2, z + d / 2 - 0.1]}
          castShadow
        >
          <boxGeometry args={[0.24, h * 0.9, 0.2]} />
          {metal("#6c7178")}
        </mesh>
      ))}
      <Front
        position={p.position}
        size={p.size}
        label={p.label}
        lit={p.active}
      />
    </group>
  );
}

function Drawer(p: ContainerProps) {
  const { Container } = parts;
  return (
    <group>
      <Container {...p} label="" />
      <Front
        position={p.position}
        size={[p.size[0], p.size[1] * 0.9, p.size[2]]}
        label={p.label}
        lit={p.active}
      />
    </group>
  );
}

function Port(p: ExitProps) {
  return (
    <group>
      <parts.Exit {...p} label={p.label.toUpperCase()} />
      <mesh position={[p.position[0], p.height + 1.7, p.position[2]]}>
        <sphereGeometry args={[0.16, 16, 12]} />
        {led(p.active, AMBER)}
      </mesh>
    </group>
  );
}

export const hardware: Look = {
  id: "hardware",
  name: "Hardware",
  summary:
    "The browser as equipment in a dark studio: brushed-metal units with engraved plates and indicator lights, black cables, an amber bead of light.",
  chrome: "dark",
  gl: { toneMapping: ACESFilmicToneMapping, exposure: 1, shadows: true },
  page,
  Stage: () => (
    <>
      <color attach="background" args={["#0b0c0e"]} />
      <fog attach="fog" args={["#0b0c0e", 45, 120]} />
      <ambientLight intensity={0.25} />
      <spotLight
        position={[-24, 14, 26]}
        angle={0.5}
        penumbra={1}
        intensity={500}
        decay={2}
        color="#c9d6ff"
      />
      <spotLight
        position={[0, 30, 22]}
        angle={0.62}
        penumbra={0.8}
        intensity={1500}
        decay={2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
      />
      <Environment resolution={128} frames={1}>
        <Lightformer
          form="rect"
          intensity={2.4}
          position={[0, 14, 10]}
          rotation-x={Math.PI / 2}
          scale={[30, 6, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.4}
          position={[-22, 5, 6]}
          rotation-y={Math.PI / 2}
          scale={[16, 3, 1]}
        />
        <Lightformer
          form="rect"
          intensity={0.6}
          position={[22, 5, 6]}
          rotation-y={-Math.PI / 2}
          scale={[16, 3, 1]}
        />
      </Environment>
    </>
  ),
  Effects: () => {
    const pass = useMemo(() => new SanitizePass(), []);
    return (
      <EffectComposer multisampling={4}>
        <primitive object={pass} />
        <Bloom
          mipmapBlur
          intensity={0.7}
          luminanceThreshold={0.85}
          luminanceSmoothing={0.15}
          radius={0.5}
        />
        <Vignette offset={0.25} darkness={0.8} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    );
  },
  parts: { ...parts, Block: Unit, Container: Drawer, Exit: Port },
};
