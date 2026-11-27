/**
 * What the client library reports in the browser, drawn where it happens:
 * the sign-in state of each page as one shape, and on each module a ring of
 * marks, one per kind of step it has reported, lit while it reports it.
 * Everything here is a function of the playback time: nothing moves unless
 * a step was reported.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, type Group, type Mesh, type MeshBasicMaterial } from "three";
import type { PageState } from "../model/recording.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { Lod } from "./Lod.tsx";
import { placementOf } from "./look.ts";
import { STATE_COLORS } from "./palette.ts";

/** Each state as arcs of one ring: [start, length] in turns. */
const ARCS: Record<PageState, [number, number][]> = {
  loading: [0, 1, 2, 3, 4, 5].map((i) => [i / 6, 1 / 12]),
  signedOut: [[0.125, 0.75]],
  signingIn: [[0.125, 0.75]],
  signedIn: [[0, 1]],
  error: [
    [0.02, 0.27],
    [0.35, 0.27],
    [0.68, 0.27],
  ],
};
/** How long a change of state takes to settle, in seconds of playback. */
const SETTLE = 0.5;

export function Browser() {
  const states = useMemo(
    () => [...world.layout.parts.values()].filter((p) => p.shape === "state"),
    [],
  );
  // The kinds of step each module reported, in the order they first came.
  const rings = useMemo(() => {
    const byPart = new Map<string, string[]>();
    for (const s of world.timeline.clientSteps) {
      const list = byPart.get(s.part) ?? [];
      if (!list.includes(s.step)) list.push(s.step);
      byPart.set(s.part, list);
    }
    return [...byPart].filter(([part]) => placementOf(part));
  }, []);
  return (
    <>
      {states.map((p) => (
        <StateShape key={p.id} id={p.id} />
      ))}
      {rings.map(([part, steps]) => (
        <group key={part} position={placementOf(part)!.position}>
          <Lod far={70}>
            <StepRing part={part} steps={steps} />
          </Lod>
        </group>
      ))}
    </>
  );
}

function StateShape({ id }: { id: string }) {
  const p = placementOf(id)!;
  const group = useRef<Group>(null);
  const core = useRef<Mesh>(null);
  const shown = useRef<PageState | null>(null);
  const color = useMemo(() => new Color(), []);
  const select = usePlayback((s) => s.select);
  // One ring per state, shown by the state the page is in.
  const shapes = useMemo(
    () =>
      (Object.keys(ARCS) as PageState[]).map((state) => ({
        state,
        arcs: ARCS[state],
      })),
    [],
  );
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const now = currentState();
    const at = now.states.get(id);
    const state: PageState = at?.state ?? "loading";
    const settle = at ? Math.min(1, (now.time - at.since) / SETTLE) : 1;
    shown.current = state;
    color
      .set(STATE_COLORS[state])
      .multiplyScalar(0.8 + 2.2 * (1 - settle) + 0.6);
    for (const child of g.children) {
      if (child.userData.state === undefined) continue;
      child.visible = child.userData.state === state;
      for (const arc of child.children)
        ((arc as Mesh).material as MeshBasicMaterial).color.copy(color);
      // A new state rises into place.
      child.scale.setScalar(0.8 + 0.2 * settle);
    }
    const c = core.current;
    if (c) {
      c.visible = state === "signedIn" || state === "signingIn";
      c.scale.setScalar(state === "signedIn" ? 1 : 0.45);
      (c.material as MeshBasicMaterial).color.copy(color).multiplyScalar(0.7);
    }
  });
  const r = p.radius;
  return (
    <group
      ref={group}
      position={[p.position[0], p.position[1] + 0.15, p.position[2]]}
      onClick={(e) => {
        if (isDrag(e)) return;
        e.stopPropagation();
        select({ type: "part", id });
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        hover.label = `sign-in state · ${shown.current ?? ""}`;
      }}
      onPointerOut={() => (hover.label = "")}
    >
      {shapes.map(({ state, arcs }) => (
        <group key={state} userData={{ state }} rotation={[-Math.PI / 2, 0, 0]}>
          {arcs.map(([start, length], i) => (
            <mesh key={i} rotation={[0, 0, start * Math.PI * 2]}>
              <torusGeometry
                args={[r, r * 0.09, 8, 48, length * Math.PI * 2]}
              />
              <meshBasicMaterial toneMapped={false} />
            </mesh>
          ))}
        </group>
      ))}
      <mesh ref={core} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[r * 0.62, 40]} />
        <meshBasicMaterial toneMapped={false} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

/** Marks around a module: one per kind of step it reported. */
function StepRing({ part, steps }: { part: string; steps: string[] }) {
  const p = placementOf(part)!;
  const marks = useRef<(Mesh | null)[]>([]);
  const base = useMemo(() => new Color(p.color), [p.color]);
  const c = useMemo(() => new Color(), []);
  const R = p.radius + 0.75;
  useFrame(() => {
    const now = currentState();
    const current = now.clientSteps.get(part);
    // A step reported before now is remembered faintly; the one now is lit.
    const seen = new Set<string>();
    for (const s of world.timeline.clientSteps) {
      if (s.start > now.time) break;
      if (s.part === part) seen.add(s.step);
    }
    steps.forEach((step, i) => {
      const m = marks.current[i];
      if (!m) return;
      const lit = current?.step === step;
      c.copy(base).multiplyScalar(lit ? 4 : seen.has(step) ? 0.55 : 0.12);
      (m.material as MeshBasicMaterial).color.copy(c);
      m.scale.set(1, lit ? 3 : 1, 1);
    });
  });
  return (
    <group>
      {steps.map((step, i) => {
        const a = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <mesh
            key={step}
            ref={(m) => {
              marks.current[i] = m;
            }}
            position={[R * Math.cos(a), 0.12, R * Math.sin(a)]}
            rotation={[0, -a, 0]}
            onPointerMove={(e) => {
              e.stopPropagation();
              hover.label = step;
            }}
            onPointerOut={() => (hover.label = "")}
          >
            <boxGeometry args={[0.22, 0.3, 0.6]} />
            <meshBasicMaterial toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}
