/**
 * What the client library reports in the browser, drawn where it happens:
 * the sign-in state of each page as one shape, and on each module a ring of
 * marks, one per kind of step it has reported, lit while it reports it;
 * and around the module reporting now, a halo that keeps its size on the
 * window, with a ripple for each step it reports, so that from the whole
 * browser region the eye finds the one module acting.
 * Everything here is a function of the playback time: nothing moves unless
 * a step was reported.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Billboard } from "@react-three/drei";
import {
  AdditiveBlending,
  Color,
  Vector3,
  type Group,
  type Mesh,
  MeshBasicMaterial,
} from "three";
import type { ClientStep } from "../model/schedule.ts";
import type { PageState } from "../model/recording.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { Lod } from "./Lod.tsx";
import { anchorPosition, placementOf } from "./look.ts";
import { STATE_COLORS, TONE_COLORS } from "./palette.ts";

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
/** How long the pulse of a change of state lasts (s of playback). */
const PULSE = 0.9;
/** How large the pulse grows, as a fraction of its distance to the camera. */
const PULSE_ON_SCREEN = 0.09;
const pulseAt = new Vector3();
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
      <Halos />
      <KeyPulses />
      <LoadSweeps />
      {states.map((p) => (
        <StateShape key={p.id} id={p.id} />
      ))}
      {rings.map(([part, steps]) => (
        <group key={part} position={placementOf(part)!.position}>
          {/* Only at the innermost level: when the module's ring spans
              about a quarter of the window's height (42° of view). */}
          <Lod far={10 * (placementOf(part)!.radius + 0.75)}>
            <StepRing part={part} steps={steps} />
          </Lod>
        </group>
      ))}
    </>
  );
}

/**
 * The keys of the page's storage that were emptied, and when: a removal the
 * page's `storage` events recorded (a drop with no value put in its place
 * at the same moment).
 */
function emptied(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const hs = world.timeline.holdings;
  for (const h of hs) {
    if (h.op !== "drop" || !placementOf(h.holder)) continue;
    if (!h.holder.startsWith("storageKey:")) continue;
    const replaced = hs.some(
      (g) => g.op === "gain" && g.holder === h.holder && g.at === h.at,
    );
    if (!replaced) out.set(h.holder, [...(out.get(h.holder) ?? []), h.at]);
  }
  return out;
}

function KeyPulses() {
  const version = usePlayback((s) => s.version);
  const keys = useMemo(() => {
    void version;
    return [...emptied()];
  }, [version]);
  return (
    <>
      {keys.map(([id, times]) => (
        <KeyPulse key={id} id={id} times={times} />
      ))}
    </>
  );
}

/** How long the sweep of a document load takes (s of playback). */
const SWEEP = 1.2;

function LoadSweeps() {
  const version = usePlayback((s) => s.version);
  const pages = useMemo(() => {
    void version;
    const out = new Map<string, number[]>();
    for (const l of world.timeline.loads)
      if (placementOf(l.page))
        out.set(l.page, [...(out.get(l.page) ?? []), l.at]);
    return [...out];
  }, [version]);
  return (
    <>
      {pages.map(([id, times]) => (
        <LoadSweep key={id} id={id} times={times} />
      ))}
    </>
  );
}

/**
 * At each recorded `load` of a page's document, one arc sweeps once around
 * the page's island: the page loaded again. What the client then does on
 * start-up begins from there, as it reported.
 */
function LoadSweep({ id, times }: { id: string; times: number[] }) {
  const p = placementOf(id)!;
  const arc = useRef<Group>(null);
  const mat = useMemo(
    () =>
      new MeshBasicMaterial({
        color: new Color("#dfe6ff").multiplyScalar(1.8),
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  useFrame(() => {
    const g = arc.current;
    if (!g) return;
    const t = currentState().time;
    const since = t - Math.max(-Infinity, ...times.filter((x) => x <= t));
    const k = since / SWEEP;
    g.visible = k >= 0 && k < 1;
    if (!g.visible) return;
    g.rotation.z = -k * Math.PI * 2;
    mat.opacity = 0.95 * Math.min(1, (1 - k) * 3);
  });
  const r = p.radius * 1.04;
  return (
    <group
      position={[p.position[0], p.position[1] + 0.2, p.position[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <group ref={arc} visible={false}>
        <mesh material={mat} raycast={() => null}>
          <torusGeometry
            args={[r, Math.max(0.12, r * 0.025), 8, 64, Math.PI * 0.6]}
          />
        </mesh>
      </group>
    </group>
  );
}

/** One pulse out of a key each time it is emptied, as the state ring's. */
function KeyPulse({ id, times }: { id: string; times: number[] }) {
  const p = placementOf(id)!;
  const ring = useRef<Mesh>(null);
  const at = useMemo(() => anchorPosition(id, new Vector3()), [id]);
  useFrame(({ camera }) => {
    const m = ring.current;
    if (!m) return;
    const t = currentState().time;
    const since = t - Math.max(-Infinity, ...times.filter((x) => x <= t));
    const k = since / PULSE;
    m.visible = k >= 0 && k < 1;
    if (!m.visible) return;
    const big = Math.max(
      p.radius * 3,
      camera.position.distanceTo(at) * PULSE_ON_SCREEN * 0.6,
    );
    const e = 1 - Math.pow(1 - k, 2);
    m.scale.setScalar(p.radius + (big - p.radius) * e);
    (m.material as MeshBasicMaterial).opacity = 0.85 * (1 - k);
  });
  return (
    <Billboard position={at}>
      <mesh ref={ring} visible={false} raycast={() => null}>
        <ringGeometry args={[0.9, 1, 48]} />
        <meshBasicMaterial
          color={new Color("#dfe6ff").multiplyScalar(1.6)}
          toneMapped={false}
          transparent
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
    </Billboard>
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
  const pulse = useRef<Mesh>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    const now = currentState();
    const at = now.states.get(id);
    // A change of state sends one pulse out of the ring, large enough on
    // the window to read from Home: driven by the reported state step.
    const m = pulse.current;
    if (m) {
      const since = at ? now.time - at.since : Infinity;
      const k = since / PULSE;
      m.visible = k >= 0 && k < 1;
      if (m.visible) {
        g.getWorldPosition(pulseAt);
        const big = Math.max(
          p.radius * 3,
          camera.position.distanceTo(pulseAt) * PULSE_ON_SCREEN,
        );
        const e = 1 - Math.pow(1 - k, 2);
        m.scale.setScalar(p.radius + (big - p.radius) * e);
        const mat = m.material as MeshBasicMaterial;
        mat.color.set(STATE_COLORS[at!.state]).multiplyScalar(2);
        mat.opacity = 0.9 * (1 - k);
      }
    }
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
      <Billboard>
        <mesh ref={pulse} visible={false} raycast={() => null}>
          <ringGeometry args={[0.9, 1, 64]} />
          <meshBasicMaterial
            toneMapped={false}
            transparent
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
      </Billboard>
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

/** Shown seconds a halo takes to fade after its module's last step. */
const HALO_FADE = 0.35;
/** A halo's radius as a fraction of its distance to the camera, at least. */
export const HALO_ON_SCREEN = 0.03;

/** A halo's radius around a part of `radius`, seen from `distance`. */
export const haloRadius = (radius: number, distance: number) =>
  Math.max(radius * 1.6, distance * HALO_ON_SCREEN);

const nextCache = new WeakMap<ClientStep[], (ClientStep | undefined)[]>();
/** For each step, the next step at another module. */
function nextElsewhere(steps: ClientStep[]) {
  let out = nextCache.get(steps);
  if (out) return out;
  out = new Array(steps.length);
  for (let i = steps.length - 1; i >= 0; i--) {
    const n = steps[i + 1];
    out[i] = !n ? undefined : n.part !== steps[i].part ? n : out[i + 1];
  }
  nextCache.set(steps, out);
  return out;
}

/**
 * How much each module is acting at time `t`, 0..1: the module of the
 * newest step reported (and not yet over) fully; one whose step a newer
 * one followed, or whose step is over, fading over {@link HALO_FADE}.
 * `steps` are in order of start.
 */
export function actingModules(
  steps: ClientStep[],
  t: number,
): { now: string | null; on: Map<string, number> } {
  const on = new Map<string, number>();
  let now: ClientStep | null = null;
  const after = nextElsewhere(steps);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.start > t) break;
    if (t > s.end + HALO_FADE || !placementOf(s.part)) continue;
    const next = after[i];
    const until = Math.min(s.end, next && next.start <= t ? next.start : s.end);
    const v = t < until ? 1 : Math.max(0, 1 - (t - until) / HALO_FADE);
    if (v > 0) on.set(s.part, Math.max(on.get(s.part) ?? 0, v));
    if (t < s.end && (!next || next.start > t)) now = s;
  }
  return { now: now?.part ?? null, on };
}

function Halos() {
  const version = usePlayback((s) => s.version);
  const steps = useMemo(() => {
    void version;
    return world.timeline.clientSteps;
  }, [version]);
  const ids = usePlayback((s) =>
    [...actingModules(steps, s.time).on.keys()].sort().join(","),
  );
  return (
    <>
      {ids
        ? ids.split(",").map((id) => <Halo key={id} part={id} steps={steps} />)
        : null}
    </>
  );
}

/**
 * The halo of a module while it reports: a soft disc and a ring facing the
 * camera, at least {@link HALO_ON_SCREEN} of the distance across, and a
 * ripple out of it at the start of each step. `steps` are what lights it,
 * as {@link actingModules} reads them; `quiet` dims it.
 */
export function Halo({
  part,
  steps,
  quiet = 1,
}: {
  part: string;
  steps: ClientStep[];
  quiet?: number;
}) {
  const p = placementOf(part)!;
  const group = useRef<Group>(null);
  const disc = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const ripple = useRef<Mesh>(null);
  const mine = useMemo(
    () => steps.filter((s) => s.part === part),
    [steps, part],
  );
  const color = useMemo(
    () => new Color(p.color).lerp(new Color("#ffffff"), 0.35),
    [p.color],
  );
  const failed = useMemo(() => new Color(TONE_COLORS.error), []);
  const at = useMemo(() => anchorPosition(part, new Vector3()), [part]);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    const t = currentState().time;
    // The step now, or the last one before now.
    let last: ClientStep | null = null;
    for (const s of mine) {
      if (s.start > t) break;
      last = s;
    }
    const on = (actingModules(steps, t).on.get(part) ?? 0) * quiet;
    g.position.copy(at);
    g.scale.setScalar(haloRadius(p.radius, camera.position.distanceTo(at)));
    const since = last ? t - last.start : 1;
    const set = (m: Mesh | null, opacity: number, scale = 1) => {
      if (!m) return;
      (m.material as MeshBasicMaterial).opacity = opacity;
      m.scale.setScalar(scale);
    };
    set(disc.current, 0.18 * on);
    set(
      ring.current,
      0.9 * on,
      1 + 0.08 * Math.sin(Math.min(1, since / 0.5) * Math.PI),
    );
    const k = Math.min(1, since / 0.5);
    set(ripple.current, 0.6 * (1 - k) * on, 1 + 1.4 * k);
    // A step that reported an error has the halo in the error colour.
    const now = last?.tone === "error" ? failed : color;
    for (const [m, x] of [
      [disc.current, 1],
      [ring.current, 2],
      [ripple.current, 1],
    ] as const)
      if (m)
        (m.material as MeshBasicMaterial).color.copy(now).multiplyScalar(x);
  });
  return (
    <group ref={group}>
      <Billboard>
        <mesh ref={disc} raycast={() => null}>
          <circleGeometry args={[1, 40]} />
          <meshBasicMaterial
            color={color}
            toneMapped={false}
            transparent
            depthWrite={false}
            depthTest={false}
            blending={AdditiveBlending}
          />
        </mesh>
        <mesh ref={ring} raycast={() => null}>
          <ringGeometry args={[0.9, 1, 48]} />
          <meshBasicMaterial
            color={color.clone().multiplyScalar(2)}
            toneMapped={false}
            transparent
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
        <mesh ref={ripple} raycast={() => null}>
          <ringGeometry args={[0.94, 1, 48]} />
          <meshBasicMaterial
            color={color}
            toneMapped={false}
            transparent
            depthWrite={false}
            depthTest={false}
            blending={AdditiveBlending}
          />
        </mesh>
      </Billboard>
    </group>
  );
}
