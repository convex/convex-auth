/**
 * Every island, instanced: a dark plinth, a glassy top, a rim of light and a
 * faint wall of light at its edge (the trust boundary). Five draw calls for
 * all of them. An island glows while code on it runs, and turns to the color
 * of a warning while one is raised there.
 */
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
} from "three";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { highlightOf } from "./highlight.ts";
import { nounOfPart, partOf, placementOf } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";

const top = new CylinderGeometry(1, 1, 0.3, 64).translate(0, -0.15, 0);
const plinth = new CylinderGeometry(1, 0.6, 1, 48, 1).translate(0, -0.5, 0);
const rim = new TorusGeometry(1, 0.012, 6, 128).rotateX(Math.PI / 2);
const wall = new CylinderGeometry(1, 1, 1, 96, 1, true).translate(0, 0.5, 0);

const wallMaterial = new ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  blending: AdditiveBlending,
  uniforms: { uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vColor;
    void main() {
      vUv = uv;
      vColor = instanceColor;
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vColor;
    void main() {
      float fade = pow(1.0 - vUv.y, 1.6);
      float lines = smoothstep(0.6, 1.0, sin(vUv.x * 240.0) * 0.5 + 0.5) * 0.25;
      float sweep = smoothstep(0.92, 1.0, sin(vUv.x * 6.2831853 - uTime * 0.6) * 0.5 + 0.5);
      gl_FragColor = vec4(vColor, fade * (0.06 + lines * 0.07 + sweep * 0.05));
    }
  `,
});

const m = new Matrix4();
const q = new Quaternion();
const v = new Vector3();
const s = new Vector3();
const c = new Color();

/** The islands that hold each part, up the chain. */
function islandsOf(id: string): string[] {
  const chain: string[] = [];
  let p = placementOf(id);
  let island = p?.shape === "island" ? id : (p?.island ?? null);
  while (island && !chain.includes(island)) {
    chain.push(island);
    p = placementOf(island);
    island =
      p && "parentIsland" in p ? (p.parentIsland as string | null) : null;
  }
  return chain;
}

export function Islands() {
  const tops = useRef<InstancedMesh>(null);
  const plinths = useRef<InstancedMesh>(null);
  const rims = useRef<InstancedMesh>(null);
  const walls = useRef<InstancedMesh>(null);
  const base = useMemo(
    () => world.layout.islands.map((i) => new Color(i.color)),
    [],
  );
  const glow = useRef(world.layout.islands.map(() => 0));
  const select = usePlayback((st) => st.select);
  const focus = world.presentation.focus;

  useLayoutEffect(() => {
    world.layout.islands.forEach((i, k) => {
      const [x, y, z] = i.position;
      const r = i.radius;
      q.identity();
      m.compose(v.set(x, y, z), q, s.set(r, 1, r));
      tops.current!.setMatrixAt(k, m);
      const depth = i.depth ? 1.2 : 2.2 + r * 0.12;
      m.compose(v.set(x, y - 0.3, z), q, s.set(r, depth, r));
      plinths.current!.setMatrixAt(k, m);
      m.compose(v.set(x, y + 0.04, z), q, s.set(r - 0.1, 1, r - 0.1));
      rims.current!.setMatrixAt(k, m);
      m.compose(v.set(x, y, z), q, s.set(r, i.depth ? 2 : 3 + r * 0.08, r));
      walls.current!.setMatrixAt(k, m);
      plinths.current!.setColorAt(k, c.set("#0a0e1a"));
      rims.current!.setColorAt(k, c.set(i.color));
      walls.current!.setColorAt(k, c.set(i.color).multiplyScalar(0.5));
      tops.current!.setColorAt(k, c.set(i.depth ? "#111a30" : "#0d1324"));
    });
    for (const mesh of [tops, plinths, rims, walls]) {
      mesh.current!.instanceMatrix.needsUpdate = true;
      mesh.current!.computeBoundingSphere();
    }
  }, []);

  useFrame(({ clock }, delta) => {
    wallMaterial.uniforms.uTime.value = clock.elapsedTime;
    const state = currentState();
    const busy = new Set<string>();
    for (const id of state.active.keys())
      for (const i of islandsOf(id)) busy.add(i);
    const alarmed = new Map<string, string>();
    for (const a of state.alerts)
      for (const i of islandsOf(a.part))
        if (!alarmed.has(i))
          alarmed.set(
            i,
            a.level === "ERROR" ? TONE_COLORS.error : TONE_COLORS.warn,
          );
    const { selected } = usePlayback.getState();
    const h = highlightOf(selected);
    world.layout.islands.forEach((i, k) => {
      const target = alarmed.has(i.id)
        ? 1.6
        : busy.has(i.id)
          ? 1
          : h.covered.has(i.id)
            ? 0.7
            : i.id === focus
              ? 0.35
              : 0;
      glow.current[k] = MathUtils.damp(glow.current[k], target, 4, delta);
      const g = glow.current[k];
      const tone = alarmed.get(i.id);
      c.copy(base[k]);
      if (tone) c.lerp(new Color(tone), Math.min(1, g));
      const dim =
        selected && !h.covered.has(i.id) && !h.linked.has(i.id) ? 0.45 : 1;
      rims.current!.setColorAt(
        k,
        c.clone().multiplyScalar((1.4 + g * 2.5) * dim),
      );
      walls.current!.setColorAt(
        k,
        c.clone().multiplyScalar((0.5 + g * 3.5) * dim),
      );
    });
    rims.current!.instanceColor!.needsUpdate = true;
    walls.current!.instanceColor!.needsUpdate = true;
  });

  const handlers = {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (e.instanceId === undefined) return;
      e.stopPropagation();
      select({ type: "part", id: world.layout.islands[e.instanceId].id });
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      if (e.instanceId === undefined) return;
      e.stopPropagation();
      const id = world.layout.islands[e.instanceId].id;
      hover.label = `${partOf(id)?.label ?? id} · ${nounOfPart(id)}`;
    },
    onPointerOut: () => (hover.label = ""),
  };

  return (
    <>
      <instancedMesh
        ref={plinths}
        args={[plinth, undefined, world.layout.islands.length]}
        {...handlers}
      >
        <meshStandardMaterial
          color="#ffffff"
          metalness={0.7}
          roughness={0.42}
        />
      </instancedMesh>
      <instancedMesh
        ref={tops}
        args={[top, undefined, world.layout.islands.length]}
        {...handlers}
      >
        <meshStandardMaterial
          color="#ffffff"
          metalness={0.85}
          roughness={0.25}
        />
      </instancedMesh>
      <instancedMesh
        ref={rims}
        args={[rim, undefined, world.layout.islands.length]}
        raycast={() => null}
      >
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={walls}
        args={[wall, wallMaterial, world.layout.islands.length]}
        raycast={() => null}
      />
    </>
  );
}
