/**
 * The few words of the world. Meaning comes from shape, place, colour and
 * movement first; text is kept to:
 *
 * - the names of the islands: the top-level ones from afar, the ones inside
 *   an island as the camera comes near it;
 * - the name of each part that is acting now (it runs, it reported a step,
 *   something leaves or reaches it), and of the selected part.
 *
 * Everything else (a part's kind, source, fields) is in the inspector, on
 * click; a part's name shows by the pointer on hover. One declutter pass
 * hides any label that would cover a more important one on screen.
 */
import { Billboard } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
  type Group,
} from "three";
import { FOOTPRINT } from "../layout/islands.ts";
import type { IslandPlacement } from "../layout/types.ts";
import { currentState, usePlayback, world } from "../store.ts";
import { highlightOf } from "./highlight.ts";
import { actingModules, haloRadius } from "./Browser.tsx";
import { KeepSize, Label } from "./Label.tsx";
import { Lod } from "./Lod.tsx";
import type { OpPath } from "../model/operations.ts";
import type { Timeline } from "../model/schedule.ts";
import { HEIGHT, partOf, placementOf, topIsland } from "./look.ts";
import { runningNow } from "./Running.tsx";

interface Entry {
  group: Group;
  /** Characters on the widest line, and the lines. */
  chars: number;
  lines: number;
  /** Font size in world units. */
  size: number;
  grow?: { distance: number; max: number };
  priority: number;
  /** Hidden when the camera is nearer than this (an island's own name). */
  hideNear?: number;
  /** Hidden when the camera is farther than this (the name of an island inside another). */
  hideFar?: number;
  /** Whether it relates to the selection or the current beat; else it fades with distance. */
  important?: () => boolean;
  /**
   * Named only once running code reached it: until `named()`, it shows
   * only nearer than `far` (or when `important`).
   */
  quiet?: { far: number; named: () => boolean };
}

const registry = new Map<string, Entry>();

function useDeclutter(key: string, entry: Omit<Entry, "group">) {
  const group = useRef<Group>(null);
  const latest = useRef(entry);
  latest.current = entry;
  useEffect(() => {
    if (!group.current) return;
    registry.set(key, { ...latest.current, group: group.current });
    return () => void registry.delete(key);
  }, [key, entry.priority, entry.chars, entry.size]);
  return group;
}

const reachCache = new WeakMap<Timeline, Map<string, number>>();

/**
 * When running code first reached each island (shown time): an activation
 * of a part on it, a write of a run to a table on it, or a movement landing
 * on it;
 * an island inside another reaches its parents too.
 */
export function reachedAt(tl: Timeline): Map<string, number> {
  const hit = reachCache.get(tl);
  if (hit) return hit;
  const out = new Map<string, number>();
  const reach = (part: string, at: number) => {
    const p = placementOf(part);
    let island: string | null =
      p?.shape === "island" ? part : (p?.island ?? null);
    const seen = new Set<string>();
    while (island && !seen.has(island)) {
      seen.add(island);
      const was = out.get(island);
      if (was === undefined || at < was) out.set(island, at);
      const q = placementOf(island);
      island =
        q && "parentIsland" in q ? (q.parentIsland as string | null) : null;
    }
  };
  for (const a of tl.activations) reach(a.node, a.start);
  // Not the rows the recording started with (no run): the recorder read
  // them, no code ran.
  for (const c of tl.rowChanges) if (c.run) reach(c.write.table, c.at);
  for (const m of tl.movements) reach(m.to, m.end);
  reachCache.set(tl, out);
  return out;
}

const ISLAND_GROW = { distance: 40, max: 3.6 };
const PART_GROW = { distance: 22, max: 2.6 };

function islandLabelSize(i: IslandPlacement) {
  // Every island name reads at the overview; large ones stay modest.
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  return i.depth
    ? clamp(0.6 + i.radius * 0.03, 0.95, 1.4)
    : clamp(0.7 + i.radius * 0.03, 1.15, 1.9);
}

function IslandLabel({ island }: { island: IslandPlacement }) {
  const text = partOf(island.id)?.label ?? island.id;
  const size = islandLabelSize(island);
  const group = useDeclutter(`island:${island.id}`, {
    chars: text.length,
    lines: 1,
    size,
    grow: ISLAND_GROW,
    priority:
      50 +
      (island.id === world.presentation.focus ? 40 : 0) +
      island.radius -
      island.depth * 4,
    hideNear: island.radius * 1.3 + 8,
    hideFar: island.depth ? island.radius * 7 + 40 : undefined,
    // Outside the client's region, an island of a kind not named at rest
    // is named once running code has reached it; until then only close in
    // (and on hover).
    ...(world.presentation.namedAtRest &&
    !world.presentation.namedAtRest.includes(partOf(island.id)?.kind ?? "") &&
    topIsland(island.id) !== world.presentation.client
      ? {
          quiet: {
            far: island.radius * 2.5 + 20,
            named: () => {
              const at = reachedAt(world.timeline).get(island.id);
              return at !== undefined && at <= currentState().time;
            },
          },
        }
      : {}),
    important: () => {
      const h = highlightOf(usePlayback.getState().selected);
      if (h.covered.has(island.id) || h.linked.has(island.id)) return true;
      const frame = currentState().beat?.frame ?? [];
      return frame.some(
        (id) => id === island.id || placementOf(id)?.island === island.id,
      );
    },
  });
  const [x, y, z] = island.position;
  return (
    <group
      ref={group}
      position={[x, y + 2.2 + island.radius * 0.12, z - island.radius * 0.55]}
    >
      <KeepSize distance={ISLAND_GROW.distance} max={ISLAND_GROW.max}>
        <Billboard>
          <Label
            fontSize={size}
            weight="bold"
            color={island.color}
            outlineWidth={size * 0.06}
            outlineColor="#03050a"
          >
            {text}
          </Label>
        </Billboard>
      </KeepSize>
    </group>
  );
}

const projected = new Vector3();
const at = new Vector3();

/** Hides labels that would cover more important ones on screen. */
function Declutter() {
  const { camera, size } = useThree();
  const last = useRef(0);
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current < 0.15) return;
    last.current = clock.elapsedTime;
    const fovScale =
      1 / Math.tan((((camera as PerspectiveCamera).fov ?? 42) * Math.PI) / 360);
    const shown: [number, number, number, number][] = [];
    const entries = [...registry.values()].sort(
      (a, b) => b.priority - a.priority,
    );
    for (const e of entries) {
      e.group.getWorldPosition(at);
      const d = camera.position.distanceTo(at);
      projected.copy(at).project(camera);
      if (
        projected.z > 1 ||
        Math.abs(projected.x) > 1.2 ||
        Math.abs(projected.y) > 1.2 ||
        (e.hideNear !== undefined && d < e.hideNear) ||
        (e.hideFar !== undefined && d > e.hideFar) ||
        (e.quiet && d > e.quiet.far && !e.quiet.named() && !e.important?.()) ||
        // From inside the map, what is far and unrelated fades.
        (e.important &&
          d > Math.max(90, camera.position.y * 2.4) &&
          !e.important())
      ) {
        e.group.visible = false;
        continue;
      }
      const k = e.grow
        ? Math.min(e.grow.max, Math.max(1, d / e.grow.distance))
        : 1;
      const px = ((e.size * k * fovScale) / d) * (size.height / 2);
      if (px < 5) {
        e.group.visible = false;
        continue;
      }
      const w = (e.chars * 0.56 * px) / 2;
      const cx = (projected.x * 0.5 + 0.5) * size.width;
      const cy = (-projected.y * 0.5 + 0.5) * size.height;
      const rect: [number, number, number, number] = [
        cx - w,
        cy - px * 0.6,
        cx + w,
        cy + px * (0.6 + (e.lines - 1) * 0.6),
      ];
      const overlaps = shown.some(
        (r) =>
          rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1],
      );
      e.group.visible = !overlaps;
      if (!overlaps) shown.push(rect);
    }
  });
  return null;
}

/**
 * The parts acting now: running, reporting a step, or at either end of
 * something moving. Updated when the set changes.
 */
/**
 * The place the newest moving body is at or going to at time `t`: of the
 * operations under way, the one that reached a place last.
 */
function bodyAt(ops: OpPath[], t: number): string | null {
  let best: { at: number; anchor: string } | null = null;
  for (const op of ops) {
    const p = op.points;
    if (p[0].at > t || p[p.length - 1].at + 0.6 < t) continue;
    let i = 0;
    while (i + 1 < p.length && p[i + 1].at <= t) i++;
    // Halfway to the next place, it is that place that is named.
    const next = p[i + 1];
    const k = next ? (t - p[i].at) / (next.at - p[i].at) : 0;
    const q = next && k > 0.5 ? next : p[i];
    const reached = next && k > 0.5 ? t : p[i].at;
    if (!best || reached > best.at) best = { at: reached, anchor: q.anchor };
  }
  return best?.anchor ?? null;
}

function useActing(): string[] {
  const [acting, setActing] = useState<string[]>([]);
  const last = useRef({ t: -1, key: "" });
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current.t < 0.1) return;
    last.current.t = clock.elapsedTime;
    const state = currentState();
    const ids = new Set<string>(state.active.keys());
    for (const t of state.travellers) {
      ids.add(t.progress < 0.5 ? t.movement.from : t.movement.to);
    }
    // In the client's region only one name: of the place the newest body
    // is at (a module, a key, the way out), else of the module reporting.
    const client = world.presentation.client;
    const inClient = (id: string) => !!client && topIsland(id) === client;
    const at =
      bodyAt(world.timeline.ops, state.time) ??
      actingModules(world.timeline.clientSteps, state.time).now;
    // In the backend, the part the call of an operation is in now.
    const run = runningNow(world.timeline, state.time);
    const list = [...ids]
      .filter((id) => !inClient(id))
      .concat(at ? [`report:${at}`] : [])
      .concat(run ? [`report:${run}`] : [])
      .filter((id) => {
        const p = placementOf(id.replace(/^report:/, ""));
        return p && p.shape !== "island" && p.shape !== "state";
      })
      .sort();
    const key = list.join(",");
    if (key !== last.current.key) {
      last.current.key = key;
      setActing(list);
    }
  });
  return acting;
}

/**
 * The name of a module reporting a step: kept at a readable size on the
 * window at any distance, beside its halo (`Browser.tsx`).
 */
const REPORT_GROW = { distance: 22, max: 1e4 };

function PartLabel({
  id,
  rank,
  reporting = false,
}: {
  id: string;
  rank: 1 | 2;
  reporting?: boolean;
}) {
  const p = placementOf(id);
  const part = partOf(id);
  const size = rank === 2 ? 0.36 : reporting ? 0.42 : 0.32;
  const grow = reporting ? REPORT_GROW : PART_GROW;
  const group = useDeclutter(`part:${id}`, {
    chars: part?.label.length ?? 4,
    lines: 1,
    size,
    grow,
    priority: rank === 2 ? 200 : reporting ? 250 : 120,
  });
  if (!p || !part) return null;
  const [x, y, z] = p.position;
  const h = HEIGHT[p.shape] * (p.radius / FOOTPRINT[p.shape]) + 0.4;
  return (
    <group position={[x, y, z]}>
      <group ref={group} position={[0, h, 0]}>
        <KeepSize distance={grow.distance} max={grow.max}>
          {/* A storage key is named only close in: from afar its mark and
              the body at it are enough. */}
          <Lod far={id.startsWith("storageKey:") ? KEY_NAME_FAR : Infinity}>
            <Billboard>
              {reporting ? (
                <BesideHalo
                  part={id}
                  radius={p.radius}
                  lift={h}
                  grow={grow}
                  chars={part.label.length}
                  size={size}
                >
                  <Label
                    fontSize={size}
                    color="#ffffff"
                    anchorX="left"
                    position={[0, -0.2, 0]}
                    weight="regular"
                    // Over what lies between it and the camera: the name of
                    // the one part acting now is not hidden by an island.
                    renderOrder={20}
                    material={ON_TOP}
                    outlineWidth={0.025}
                    outlineColor="#03050a"
                  >
                    {part.label}
                  </Label>
                </BesideHalo>
              ) : (
                <Label
                  fontSize={size}
                  color="#ffffff"
                  weight={rank === 2 ? "bold" : "regular"}
                  outlineWidth={0.025}
                  outlineColor="#03050a"
                >
                  {part.label}
                </Label>
              )}
            </Billboard>
          </Lod>
        </KeepSize>
      </group>
    </group>
  );
}

/** How far right on the window (device coordinates) a name may end. */
const EDGE = 0.97;
const right = new Vector3();
const end = new Vector3();

/** The material of a name drawn over everything: it is not hidden by depth. */
const ON_TOP = new MeshBasicMaterial({
  depthTest: false,
  depthWrite: false,
  transparent: true,
  toneMapped: false,
});

/**
 * Puts what it holds just right of the halo of a part (`haloRadius`), in
 * the units of a `KeepSize` group of `grow` at `lift` over the part; just
 * left of it when the name would cross the window's right edge.
 */
function BesideHalo({
  part,
  radius,
  lift,
  grow,
  chars,
  size,
  children,
}: {
  part: string;
  radius: number;
  lift: number;
  grow: { distance: number; max: number };
  /** The length of the name and its font size, to keep it on the window. */
  chars: number;
  size: number;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  const at = useMemo(() => {
    const [x, y, z] = placementOf(part)!.position;
    return new Vector3(x, y + lift, z);
  }, [part, lift]);
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g) return;
    const d = camera.position.distanceTo(at);
    const scale = Math.min(grow.max, Math.max(1, d / grow.distance));
    const beside = haloRadius(radius, d) * 1.15;
    // Where the name would end on the window, read to the right.
    const across = (chars * 0.5 * size + 0.1) * scale;
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    end
      .copy(at)
      .addScaledVector(right, beside + across)
      .project(camera);
    // Past the window's right edge: on the left of the halo instead.
    g.position.x = end.x > EDGE ? -(beside + across) / scale : beside / scale;
  });
  return <group ref={ref}>{children}</group>;
}

/** The farthest a storage key's name shows from (world units). */
const KEY_NAME_FAR = 45;

export function Labels() {
  const acting = useActing();
  const selected = usePlayback((s) => s.selected);
  const chosen = useMemo(() => {
    const h = highlightOf(selected);
    return h.island
      ? []
      : [...h.covered].filter((id) => placementOf(id)?.shape !== "island");
  }, [selected]);
  return (
    <>
      <Declutter />
      {world.layout.islands.map((i) => (
        <IslandLabel key={i.id} island={i} />
      ))}
      {chosen.map((id) => (
        <PartLabel key={`s:${id}`} id={id} rank={2} />
      ))}
      {acting
        .filter(
          (id) =>
            !chosen.includes(id) &&
            !(acting.includes(`report:${id}`) && !id.startsWith("report:")),
        )
        .map((id) =>
          id.startsWith("report:") ? (
            <PartLabel
              key={`r:${id}`}
              id={id.slice("report:".length)}
              rank={1}
              reporting
            />
          ) : (
            <PartLabel key={`a:${id}`} id={id} rank={1} />
          ),
        )}
    </>
  );
}
