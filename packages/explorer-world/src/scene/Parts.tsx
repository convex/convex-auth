/**
 * Every part that is not an island, drawn with one instanced mesh per shape:
 * a few draw calls whatever the size of the system. Each shape has a dark
 * body and a glowing core; the core lights while the part runs, when it is
 * selected, and when it is at the other end of a selected part's links.
 */
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { FOOTPRINT } from "../layout/islands.ts";
import type { Placement } from "../layout/types.ts";
import type { Profile, Shape } from "../presentation.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { isDrag } from "./clicks.ts";
import { presence } from "./Groups.tsx";
import { highlightOf } from "./highlight.ts";
import { linkColor, nounOfPart, partOf } from "./look.ts";
import { TONE_COLORS } from "./palette.ts";

const SIDES: Record<Profile, number> = { round: 20, hex: 6, square: 4, tri: 3 };

interface ShapeGeometry {
  body: BufferGeometry;
  core: BufferGeometry;
}

const cache = new Map<string, ShapeGeometry>();

const firstReports = new WeakMap<object, Map<string, number>>();
/** When a part first reported a step the client library reported, if it did. */
function firstReport(id: string): number | undefined {
  const steps = world.timeline.clientSteps;
  let m = firstReports.get(steps);
  if (!m) {
    m = new Map();
    for (const s of steps) if (!m.has(s.part)) m.set(s.part, s.start);
    firstReports.set(steps, m);
  }
  return m.get(id);
}

function geometryOf(shape: Shape, profile: Profile | undefined): ShapeGeometry {
  const key = `${shape}|${profile ?? ""}`;
  const known = cache.get(key);
  if (known) return known;
  let g: ShapeGeometry;
  switch (shape) {
    case "pillar": {
      const n = SIDES[profile ?? "round"];
      g = {
        body: new CylinderGeometry(0.58, 0.72, 2.2, n).translate(0, 1.1, 0),
        core: new CylinderGeometry(0.5, 0.5, 0.12, n).translate(0, 2.26, 0),
      };
      if (n === 4) {
        g.body.rotateY(Math.PI / 4);
        g.core.rotateY(Math.PI / 4);
      }
      break;
    }
    case "vault":
      g = {
        body: new BoxGeometry(3.6, 0.5, 2.6).translate(0, 0.25, 0),
        core: new BoxGeometry(3.3, 0.04, 2.3).translate(0, 0.52, 0),
      };
      break;
    case "obelisk":
      g = {
        body: new CylinderGeometry(0.18, 0.75, 3.2, 4).translate(0, 1.6, 0),
        core: new OctahedronGeometry(0.34).translate(0, 3.55, 0),
      };
      break;
    case "gate":
      g = {
        body: new TorusGeometry(1.0, 0.16, 8, 24, Math.PI),
        core: new TorusGeometry(1.0, 0.05, 6, 32)
          .rotateX(Math.PI / 2)
          .translate(0, 0.04, 0),
      };
      break;
    case "post":
      g = {
        body: new CylinderGeometry(0.08, 0.12, 1.4, 6).translate(0, 0.7, 0),
        core: new SphereGeometry(0.22, 12, 8).translate(0, 1.5, 0),
      };
      break;
    case "shard":
      g = {
        body: new OctahedronGeometry(0.5).scale(1, 1.7, 1).translate(0, 1.4, 0),
        core: new CylinderGeometry(0.5, 0.5, 0.04, 16).translate(0, 0.02, 0),
      };
      break;
    case "beacon":
      g = {
        body: new CylinderGeometry(1.3, 2.3, 8, 8).translate(0, 4, 0),
        core: new CylinderGeometry(0.22, 0.22, 16, 8).translate(0, 16, 0),
      };
      break;
    default:
      g = {
        body: new SphereGeometry(0.45, 12, 8).translate(0, 0.5, 0),
        core: new CylinderGeometry(0.55, 0.55, 0.04, 16).translate(0, 0.02, 0),
      };
  }
  cache.set(key, g);
  return g;
}

export function Parts() {
  const groups = useMemo(() => {
    const map = new Map<string, Placement[]>();
    for (const p of world.layout.parts.values()) {
      // A page's state has a scene of its own (`Browser.tsx`).
      if (p.shape === "island" || p.shape === "state") continue;
      const key = `${p.shape}|${p.profile ?? ""}`;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.values()];
  }, []);
  return (
    <>
      {groups.map((items) => (
        <ShapeInstances
          key={`${items[0].shape}|${items[0].profile ?? ""}`}
          items={items}
        />
      ))}
    </>
  );
}

const m = new Matrix4();
const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const pos = new Vector3();
const scale = new Vector3();
const c = new Color();
const white = new Color("#ffffff");

function ShapeInstances({ items }: { items: Placement[] }) {
  const body = useRef<InstancedMesh>(null);
  const core = useRef<InstancedMesh>(null);
  const shape = items[0].shape;
  const geometry = geometryOf(shape, items[0].profile);
  const base = useMemo(() => items.map((p) => new Color(p.color)), [items]);
  const select = usePlayback((s) => s.select);

  useLayoutEffect(() => {
    items.forEach((p, i) => {
      pos.set(...p.position);
      const s = p.radius / FOOTPRINT[shape];
      scale.set(s, s, s);
      // A gate faces the middle of the world; the rest turn a little, by id.
      const yaw =
        shape === "gate"
          ? Math.atan2(-p.position[0], -p.position[2])
          : ((hash(p.id) % 360) * Math.PI) / 180;
      q.setFromAxisAngle(up, shape === "pillar" || shape === "vault" ? 0 : yaw);
      m.compose(pos, q, scale);
      body.current!.setMatrixAt(i, m);
      core.current!.setMatrixAt(i, m);
    });
    body.current!.instanceMatrix.needsUpdate = true;
    core.current!.instanceMatrix.needsUpdate = true;
    body.current!.computeBoundingSphere();
    core.current!.computeBoundingSphere();
  }, [items, shape]);

  const last = useRef("");
  useFrame(({ clock }) => {
    const b = body.current;
    const k = core.current;
    if (!b || !k) return;
    const state = currentState();
    const { selected } = usePlayback.getState();
    const h = highlightOf(selected);
    const any = selected !== null;
    // Rewrite colors only when something they depend on changed, or while a
    // part runs (it pulses).
    const busy = items.some((p) => state.active.has(p.id));
    const key = `${state.time}|${JSON.stringify(selected)}`;
    if (!busy && key === last.current && b.instanceColor) return;
    last.current = key;
    const pulse = 0.8 + 0.2 * Math.sin(clock.elapsedTime * 6);
    items.forEach((p, i) => {
      const active = state.active.get(p.id);
      const covered = h.covered.has(p.id);
      const linkKind = h.linked.get(p.id);
      const related = covered || linkKind !== undefined;
      // A part of a group whose code has taken no part recedes.
      const dim =
        (any && !related && !active ? 0.35 : 1) *
        (active || related ? 1 : presence(p.id, state.time));
      c.copy(base[i]).multiplyScalar(0.22 * dim);
      b.setColorAt(i, c);
      if (active) {
        c.set(
          active.tone === "normal"
            ? base[i]
            : new Color(TONE_COLORS[active.tone]),
        )
          .lerp(white, 0.25)
          .multiplyScalar(4 * pulse);
      } else if (covered && !h.island) c.copy(white).multiplyScalar(2.6);
      else if (covered)
        c.copy(base[i]).multiplyScalar(shape === "vault" ? 0.6 : 1.4);
      else if (linkKind) c.set(linkColor(linkKind)).multiplyScalar(2.2);
      else
        c.copy(base[i]).multiplyScalar(
          (shape === "vault" ? 0.35 : 0.9) *
            dim *
            // A part that has reported a step by now stays a little warmer.
            ((firstReport(p.id) ?? Infinity) <= state.time ? 1.8 : 1),
        );
      k.setColorAt(i, c);
    });
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (k.instanceColor) k.instanceColor.needsUpdate = true;
  });

  const handlers = {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (isDrag(e)) return;
      if (e.instanceId === undefined) return;
      e.stopPropagation();
      select({ type: "part", id: items[e.instanceId].id });
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      if (e.instanceId === undefined) return;
      e.stopPropagation();
      const id = items[e.instanceId].id;
      hover.label = `${partOf(id)?.label ?? id} · ${nounOfPart(id)}`;
    },
    onPointerOut: () => (hover.label = ""),
  };

  return (
    <>
      <instancedMesh
        ref={body}
        args={[geometry.body, undefined, items.length]}
        {...handlers}
      >
        <meshStandardMaterial
          color="#ffffff"
          metalness={0.55}
          roughness={0.32}
        />
      </instancedMesh>
      <instancedMesh
        ref={core}
        args={[geometry.core, undefined, items.length]}
        raycast={shape === "beacon" ? () => null : undefined}
        {...(shape === "beacon" ? {} : handlers)}
      >
        <meshBasicMaterial
          color="#ffffff"
          toneMapped={false}
          transparent={shape === "beacon"}
          opacity={shape === "beacon" ? 0.35 : 1}
          depthWrite={shape !== "beacon"}
        />
      </instancedMesh>
    </>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
