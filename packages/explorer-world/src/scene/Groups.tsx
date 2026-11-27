/**
 * The groups of parts on an island (`Cluster` in `layout/types.ts`): each
 * stands on a ground of its own with a rim, so a district reads as a few
 * named things with things inside, not as many loose parts. Names come by
 * distance, a level at a time, and never all at once:
 *
 * - from where the whole district is in view, one name per group;
 * - close to one group (the camera looking at it), its members' names, and
 *   no member of any other group;
 * - closer still, the names of the parts below a member (a module's hooks)
 *   within a few metres.
 *
 * The declutter pass of `Labels.tsx` then hides a name that would cover a
 * more important one. A group whose code has taken part (see
 * `model/takenPart.ts`) has a bright rim and name; one the app is wired to
 * by its source, a softer one; the rest recede, still there and named
 * close in.
 */
import { Billboard } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CircleGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Quaternion,
  RingGeometry,
  Vector3,
} from "three";
import { FOOTPRINT } from "../layout/islands.ts";
import type { Cluster, IslandPlacement } from "../layout/types.ts";
import { takenPart, type TakenPart } from "../model/takenPart.ts";
import type { Timeline } from "../model/schedule.ts";
import { currentState, hover, world } from "../store.ts";
import { KeepSize, Label } from "./Label.tsx";
import { useDeclutter } from "./Labels.tsx";
import { HEIGHT, partOf, placementOf } from "./look.ts";

const factsCache = new WeakMap<Timeline, TakenPart>();

/** Which groups and parts have taken part, for the current recording. */
export function groupFacts(): TakenPart {
  let f = factsCache.get(world.timeline);
  if (!f) {
    f = takenPart(
      world.index,
      world.layout,
      world.timeline,
      world.presentation.focus,
    );
    factsCache.set(world.timeline, f);
  }
  return f;
}

export type Standing = "took" | "wired" | "quiet";

/** Where a group stands at shown time `t`. */
export function standingOf(id: string, t: number): Standing {
  const f = groupFacts();
  const e = f.groups.get(id);
  if (e && e.at <= t) return "took";
  return f.wired.has(id) ? "wired" : "quiet";
}

/**
 * How bright a part in a group is drawn at `t` (1 for a part outside any
 * group): full once it reported, softer in a group that took part or is
 * wired, low otherwise.
 */
export function presence(id: string, t: number): number {
  const f = groupFacts();
  const c = f.groupOf.get(id);
  if (!c) return 1;
  const at = f.parts.get(id);
  if (at !== undefined && at <= t) return 1;
  return standingOf(c.id, t) === "quiet" ? RECEDE : 0.6;
}

/** How bright a part of a group that took no part is drawn. */
const RECEDE = 0.3;

/** The name of a group: the presentation's, else the data's. */
export const groupName = (c: Cluster) =>
  world.presentation.groups?.[c.id]?.label ?? c.label;

const all = () =>
  world.layout.islands.flatMap((i) => i.clusters.map((c) => ({ i, c })));

const disc = new CircleGeometry(1, 48).rotateX(-Math.PI / 2);
const ring = new RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2);
const m = new Matrix4();
const q = new Quaternion();
const v = new Vector3();
const s = new Vector3();
const col = new Color();
const target = new Vector3();
const centre = new Vector3();

const LOOK: Record<Standing, { ground: number; rim: number; name: string }> = {
  took: { ground: 0.12, rim: 1.5, name: "#eaf2ff" },
  wired: { ground: 0.075, rim: 0.7, name: "#b8c7e8" },
  quiet: { ground: 0.045, rim: 0.22, name: "#7484a6" },
};

export function Groups() {
  const list = useMemo(all, []);
  // For scripted checks: where each group stands now.
  (globalThis as { explorerGroups?: unknown }).explorerGroups = () =>
    Object.fromEntries(
      list.map(({ c }) => [c.id, standingOf(c.id, currentState().time)]),
    );
  const grounds = useRef<InstancedMesh>(null);
  const rims = useRef<InstancedMesh>(null);
  const controls = useThree((st) => st.controls) as unknown as {
    getTarget?: (out: Vector3, end?: boolean) => Vector3;
  } | null;

  useLayoutEffect(() => {
    list.forEach(({ c }, k) => {
      const [x, y, z] = c.center;
      // Under the glowing base of a shard (0.04 high), over the island.
      m.compose(v.set(x, y + 0.006, z), q, s.set(c.radius, 1, c.radius));
      grounds.current!.setMatrixAt(k, m);
      m.compose(v.set(x, y + 0.012, z), q, s.set(c.radius, 1, c.radius));
      rims.current!.setMatrixAt(k, m);
    });
    for (const mesh of [grounds, rims]) {
      if (!mesh.current) continue;
      mesh.current.instanceMatrix.needsUpdate = true;
      mesh.current.computeBoundingSphere();
    }
  }, [list]);

  // The group the camera is close to and looking at, if any: only its
  // members' names are mounted.
  const [near, setNear] = useState<string | null>(null);
  const last = useRef({ key: "", at: -1 });
  useFrame(({ camera, clock }) => {
    if (clock.elapsedTime - last.current.at < 0.12) return;
    last.current.at = clock.elapsedTime;
    // The group looked at, from near enough.
    if (controls?.getTarget) controls.getTarget(target, false);
    let best: string | null = null;
    let score = Infinity;
    for (const { c } of list) {
      centre.set(...c.center);
      const off = Math.hypot(target.x - centre.x, target.z - centre.z);
      const slack = c.radius * 1.3 + 2;
      if (off > slack) continue;
      if (camera.position.distanceTo(centre) > c.radius * 3 + 12) continue;
      if (off / slack < score) {
        score = off / slack;
        best = c.id;
      }
    }
    if (best !== near) setNear(best);
    const t = currentState().time;
    const key = list.map(({ c }) => standingOf(c.id, t)).join();
    if (key === last.current.key) return;
    last.current.key = key;
    list.forEach(({ i, c }, k) => {
      const look = LOOK[standingOf(c.id, t)];
      col.set(i.color).multiplyScalar(look.ground);
      grounds.current!.setColorAt(k, col);
      col.set(i.color).multiplyScalar(look.rim);
      rims.current!.setColorAt(k, col);
    });
    for (const mesh of [grounds, rims])
      if (mesh.current?.instanceColor)
        mesh.current.instanceColor.needsUpdate = true;
  });

  if (!list.length) return null;
  return (
    <>
      <instancedMesh
        ref={grounds}
        args={[disc, undefined, list.length]}
        onPointerMove={(e) => {
          if (e.instanceId === undefined) return;
          e.stopPropagation();
          const c = list[e.instanceId].c;
          hover.label = `${groupName(c)} · ${c.members.length} parts`;
        }}
        onPointerOut={() => (hover.label = "")}
      >
        <meshBasicMaterial
          color="#ffffff"
          toneMapped={false}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </instancedMesh>
      <instancedMesh
        ref={rims}
        args={[ring, undefined, list.length]}
        raycast={() => null}
      >
        <meshBasicMaterial
          color="#ffffff"
          toneMapped={false}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </instancedMesh>
      {list.map(({ i, c }) => (
        <GroupNames key={c.id} island={i} cluster={c} open={near === c.id} />
      ))}
    </>
  );
}

// Sizes on the window: a group's name about 22 px from 12 m to 80 m, a
// member's about 18 px and a hook's about 14 px from 8 m out; nearer, they
// grow a little.
const GROUP_GROW = { distance: 12, max: 7 };
const MEMBER_GROW = { distance: 8, max: 3 };

function GroupNames({
  island,
  cluster: c,
  open,
}: {
  island: IslandPlacement;
  cluster: Cluster;
  /** Whether its members are named (the camera is close, looking at it). */
  open: boolean;
}) {
  const text = groupName(c);
  const size = 0.25;
  const { ref: color, standing } = useStanding(c.id);
  // Off when the whole region around is in view: the district's own name
  // is enough from there.
  const group = useDeclutter(`group:${c.id}`, {
    chars: text.length,
    lines: 1,
    size,
    grow: GROUP_GROW,
    priority:
      60 +
      c.radius +
      (standing === "took" ? 30 : standing === "wired" ? 15 : 0),
    hideFar: island.radius * 4 + 20,
    // Close to the group and looking at it, its members' names take over.
    when: () => !openRef.current,
  });
  const openRef = useRef(open);
  openRef.current = open;
  const [x, y, z] = c.center;
  const roots = useMemo(
    () => c.members.filter((id) => !c.members.includes(parentOf(id) ?? "")),
    [c],
  );
  return (
    <>
      <group ref={group} position={[x, y + 0.45, z + c.radius + 0.2]}>
        <KeepSize distance={GROUP_GROW.distance} max={GROUP_GROW.max}>
          <Billboard>
            <Label
              ref={color}
              fontSize={size}
              weight="bold"
              color="#ffffff"
              outlineWidth={size * 0.08}
              outlineColor="#03050a"
            >
              {text}
            </Label>
          </Billboard>
        </KeepSize>
      </group>
      {open &&
        c.members.map((id) => (
          <MemberName
            key={id}
            id={id}
            text={
              roots.includes(id)
                ? (partOf(id)?.label ?? id).slice(
                    c.prefix ? c.prefix.length + 1 : 0,
                  )
                : (partOf(id)?.label ?? id)
            }
            below={!roots.includes(id)}
          />
        ))}
    </>
  );
}

const parentOf = (id: string) => partOf(id)?.parent ?? null;

/** Within this distance (m) the parts below a member are named. */
const BELOW_NEAR = 7;

function MemberName({
  id,
  text,
  below,
}: {
  id: string;
  text: string;
  below: boolean;
}) {
  const p = placementOf(id);
  const size = below ? 0.11 : 0.14;
  const group = useDeclutter(`member:${id}`, {
    chars: text.length,
    lines: 1,
    size,
    grow: MEMBER_GROW,
    priority: below ? 52 : 56,
    hideFar: below ? BELOW_NEAR : undefined,
  });
  const color = usePartColor(id);
  if (!p) return null;
  const h = HEIGHT[p.shape] * (p.radius / FOOTPRINT[p.shape]) + 0.3;
  const [x, y, z] = p.position;
  return (
    <group ref={group} position={[x, y + h, z]}>
      <KeepSize distance={MEMBER_GROW.distance} max={MEMBER_GROW.max}>
        <Billboard>
          <Label
            ref={color}
            fontSize={size}
            weight="regular"
            color="#ffffff"
            outlineWidth={size * 0.09}
            outlineColor="#03050a"
          >
            {text}
          </Label>
        </Billboard>
      </KeepSize>
    </group>
  );
}

type Colored = { color: unknown; sync?: () => void } | null;

/**
 * Keeps a group's name in the colour of where it stands now, and gives the
 * standing for its priority: a group that took part wins a crowded spot.
 */
function useStanding(id: string) {
  const ref = useRef<Colored>(null);
  const [standing, setStanding] = useState<Standing>(() =>
    standingOf(id, currentState().time),
  );
  const last = useRef("");
  useFrame(() => {
    const now = standingOf(id, currentState().time);
    if (now !== standing) setStanding(now);
    const t = ref.current;
    if (!t) return;
    const c = LOOK[now].name;
    if (c === last.current) return;
    last.current = c;
    t.color = c;
    t.sync?.();
  });
  return { ref, standing };
}

/** Keeps a member's name bright once it reported, quiet before. */
function usePartColor(id: string) {
  const ref = useRef<Colored>(null);
  const last = useRef("");
  useFrame(() => {
    const t = ref.current;
    if (!t) return;
    const k = presence(id, currentState().time);
    const c = k >= 1 ? "#ffffff" : k > RECEDE ? "#b8c7e8" : "#7484a6";
    if (c === last.current) return;
    last.current = c;
    t.color = c;
    t.sync?.();
  });
  return ref;
}
