import { Environment, Lightformer, Sparkles, Stars } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from "three";
import { usePlayback, world } from "../store.ts";
import { BACKGROUND, PLATFORM_COLOR } from "./palette.ts";

/** The space the world floats in, and the floor of the platform. */
export function Backdrop() {
  const span = world.layout.platform.radius;
  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, span * 2.2, span * 6]} />
      <hemisphereLight args={["#6b7fff", "#05070d", 0.35]} />
      <directionalLight
        position={[-30, 60, 40]}
        intensity={1.1}
        color="#dfe8ff"
      />
      <directionalLight
        position={[50, 20, -60]}
        intensity={0.5}
        color="#7a5cff"
      />
      <Stars
        radius={Math.max(260, span * 4)}
        depth={80}
        count={4000}
        factor={5}
        saturation={0.4}
        fade
        speed={0.4}
      />
      <Sparkles
        count={160}
        scale={[span * 2.4, 40, span * 2]}
        position={[0, 10, -8]}
        size={2.2}
        speed={0.15}
        opacity={0.35}
        color="#9fb6ff"
      />
      {/* Local light shapes for reflections on metal; nothing is fetched. */}
      <Environment resolution={128} frames={1}>
        <Lightformer
          form="rect"
          intensity={2.5}
          color="#7f8cff"
          position={[0, 20, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[60, 60, 1]}
        />
        <Lightformer
          form="ring"
          intensity={4}
          color="#3fe0d0"
          position={[30, 6, -20]}
          scale={8}
        />
        <Lightformer
          form="rect"
          intensity={2}
          color="#b48cff"
          position={[-40, 8, 20]}
          rotation={[0, Math.PI / 2, 0]}
          scale={[30, 8, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.2}
          color="#ffb454"
          position={[20, 4, 40]}
          rotation={[0, Math.PI, 0]}
          scale={[30, 4, 1]}
        />
      </Environment>
      <PlatformFloor />
    </>
  );
}

const floorVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const floorFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    // Concentric contour lines, slowly drifting outward.
    float rings = smoothstep(0.035, 0.0, abs(fract(r * 14.0 - uTime * 0.05) - 0.5) - 0.47);
    // Spokes, faint.
    float a = atan(p.y, p.x);
    float spokes = smoothstep(0.02, 0.0, abs(fract(a / 6.2831853 * 36.0) - 0.5) - 0.48) * 0.35;
    float edge = smoothstep(0.93, 0.995, r) * smoothstep(1.0, 0.985, r);
    float body = (1.0 - r) * 0.08;
    float alpha = body + (rings + spokes) * 0.07 * (1.0 - r * 0.6) + edge * 0.9;
    gl_FragColor = vec4(uColor * (0.6 + edge * 1.8), alpha);
  }
`;

const wallVertex = floorVertex;
const wallFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 2.2);
    float scan = 0.5 + 0.5 * sin(vUv.x * 600.0);
    float band = smoothstep(0.0, 0.08, fract(vUv.y * 3.0 - uTime * 0.12)) * 0.15;
    gl_FragColor = vec4(uColor, fade * (0.10 + scan * 0.04 + band * 0.2));
  }
`;

function PlatformFloor() {
  const { center, radius } = world.layout.platform;
  const color = useMemo(() => new Color(PLATFORM_COLOR), []);
  const floor = useRef<ShaderMaterial>(null);
  const wall = useRef<ShaderMaterial>(null);
  const select = usePlayback((s) => s.select);
  const uniforms = useMemo(
    () => ({ uColor: { value: color }, uTime: { value: 0 } }),
    [color],
  );
  const wallUniforms = useMemo(
    () => ({ uColor: { value: color }, uTime: { value: 0 } }),
    [color],
  );
  useFrame(({ clock }) => {
    if (floor.current) floor.current.uniforms.uTime.value = clock.elapsedTime;
    if (wall.current) wall.current.uniforms.uTime.value = clock.elapsedTime;
  });
  return (
    <group position={center}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          select(null);
        }}
      >
        <circleGeometry args={[radius, 160]} />
        <shaderMaterial
          ref={floor}
          vertexShader={floorVertex}
          fragmentShader={floorFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
        />
      </mesh>
      {/* The edge of the deployment: a faint wall of light. */}
      <mesh position={[0, 6, 0]} raycast={() => null}>
        <cylinderGeometry args={[radius, radius, 12, 200, 1, true]} />
        <shaderMaterial
          ref={wall}
          vertexShader={wallVertex}
          fragmentShader={wallFragment}
          uniforms={wallUniforms}
          transparent
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
        />
      </mesh>
    </group>
  );
}
