import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ReactNode } from "react";
import {
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  type Camera,
  type Fog,
  type Group,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from "three";
import {
  LAYERS,
  gpuInfo,
  layerGroupName,
  scanScene,
  useDiag,
  type LayerName,
} from "../diag.ts";

/** A layer of the scene, which the diagnostics can hide. */
export function Layer({
  name,
  children,
}: {
  name: LayerName;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  const on = useDiag((s) => s.layers[name]);
  return (
    <group ref={ref} name={layerGroupName(name)} visible={on}>
      {children}
    </group>
  );
}

/** Live facts for the panel, written each frame where the panel reads them. */
export const diagLive = {
  info: {} as Record<string, string>,
  canvas: "",
  camera: "",
};

/**
 * Applies the fog switch, exposes the scan to scripted checks, and while the
 * panel is open, scans the scene buffer once a second.
 */
export function Diagnostics() {
  const { gl, scene, camera } = useThree();
  const open = useDiag((s) => s.open);
  const fogOn = useDiag((s) => s.fog);
  const fog = useRef<Fog | null>(null);
  const lastScan = useRef(0);

  useEffect(() => {
    diagLive.info = gpuInfo(gl);
    (window as unknown as { explorerDiag: unknown }).explorerDiag = {
      scan: (options: ScanOptions = {}) => scanWith(gl, scene, camera, options),
      info: () => gpuInfo(gl),
      inject: (on: boolean) => inject(scene, on),
      state: useDiag,
    };
  }, [gl, scene, camera]);

  useFrame(({ camera, size, viewport }) => {
    if (scene.fog) fog.current = scene.fog as Fog;
    if (fogOn && !scene.fog && fog.current) scene.fog = fog.current;
    if (!fogOn && scene.fog) scene.fog = null;
    if (!open) return;
    const c = camera as typeof camera & { near: number; far: number };
    diagLive.canvas = `${size.width}×${size.height} css px, dpr ${viewport.dpr}, buffer ${gl.domElement.width}×${gl.domElement.height}`;
    diagLive.camera = `near ${c.near}, far ${c.far}, distance from origin ${camera.position.length().toFixed(1)}`;
    const now = performance.now();
    if (now - lastScan.current < 1000) return;
    lastScan.current = now;
    // A quarter of the pixels: enough to find a bad material, cheap enough
    // to repeat while the panel is open.
    useDiag.setState({ scan: scanScene(gl, scene, camera, "half", 0.5) });
  });
  return null;
}

interface ScanOptions {
  type?: "half" | "float";
  scale?: number;
  /** Look from here at there, for this scan only. */
  at?: { position: [number, number, number]; target: [number, number, number] };
  /** Draw only these layers, for this scan only. */
  only?: LayerName[];
  fog?: boolean;
}

/** A scan of a chosen view and chosen layers, for scripted checks. */
function scanWith(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  { type = "half", scale = 1, at, only, fog }: ScanOptions,
) {
  const view = camera.clone();
  if (at) {
    view.position.set(...at.position);
    view.lookAt(new Vector3(...at.target));
    view.updateMatrixWorld();
  }
  const hidden: Object3D[] = [];
  if (only)
    for (const layer of LAYERS) {
      const g = scene.getObjectByName(layerGroupName(layer));
      if (g && g.visible && !only.includes(layer)) {
        g.visible = false;
        hidden.push(g);
      }
    }
  const sceneFog = scene.fog;
  if (fog === false) scene.fog = null;
  try {
    return scanScene(gl, scene, view, type, scale);
  } finally {
    for (const g of hidden) g.visible = true;
    scene.fog = sceneFog;
  }
}

let faulty: Mesh | null = null;

/**
 * Adds a small quad whose shader outputs NaN, for checks of the safety net
 * (`SanitizePass`): with it, the scene buffer has non-finite pixels and the
 * frame must still show the world.
 */
function inject(scene: Scene, on: boolean) {
  if (on && !faulty) {
    faulty = new Mesh(
      new PlaneGeometry(4, 4),
      new ShaderMaterial({
        uniforms: { uZero: { value: 0 } },
        vertexShader: /* glsl */ `
          void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uZero;
          void main() {
            vec3 inf = vec3(1.0) / uZero;
            gl_FragColor = vec4(inf - inf, 1.0);
          }
        `,
      }),
    );
    faulty.name = "diag:faulty";
    scene.add(faulty);
  }
  if (!on && faulty) {
    scene.remove(faulty);
    faulty = null;
  }
  return faulty;
}
