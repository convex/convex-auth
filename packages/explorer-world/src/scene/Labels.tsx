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
  type Camera,
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
import { TONE_COLORS } from "./palette.ts";
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
  /** A name beside a halo: placed beside it, else below it, else hidden. */
  beside?: Beside;
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
  }, [key, entry.priority, entry.chars, entry.size, entry.beside]);
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
      if (e.beside) {
        const free = (r: [number, number, number, number]) =>
          !shown.some(
            (q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1],
          );
        const side = e.beside.rect(camera, size, "side");
        const below = e.beside.rect(camera, size, "below");
        const rect = free(side) ? side : free(below) ? below : null;
        e.beside.mode = rect === below ? "below" : "side";
        e.group.visible = !!rect;
        // With room around it: a name just touching it is hidden too.
        if (rect)
          shown.push([
            rect[0] - ROOM,
            rect[1] - ROOM,
            rect[2] + ROOM,
            rect[3] + ROOM,
          ]);
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
function bodyAt(
  ops: OpPath[],
  t: number,
): { anchor: string; code?: string } | null {
  let best: { at: number; anchor: string; code?: string } | null = null;
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
    // Back with a refusal: named by its code, not the module.
    const refused =
      op.code && op.errorAt !== undefined && t >= op.errorAt
        ? op.code
        : undefined;
    if (!best || reached > best.at)
      best = { at: reached, anchor: q.anchor, code: refused };
  }
  return best ? { anchor: best.anchor, code: best.code } : null;
}

/** Between a part's id and the text that names it instead, in an acting key. */
const CODE = "|code:";

function useActing(): string[] {
  const [acting, setActing] = useState<string[]>([]);
  const last = useRef({ t: -1, key: "" });
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current.t < 0.1) return;
    last.current.t = clock.elapsedTime;
    const state = currentState();
    // In the client's region only one name: of the place the newest body
    // is at (a module, a key, the way out), else of the module reporting.
    const body = bodyAt(world.timeline.ops, state.time);
    const at =
      body?.anchor ?? actingModules(world.timeline.clientSteps, state.time).now;
    // The backend has one name too: of the part the call of an operation
    // is in now, at its kept size. What else runs or moves there (a query
    // run again, a row on its way) has its halo or its body, not a small
    // name; a click names it.
    const run = runningNow(world.timeline, state.time);
    const list = [
      ...(at ? [`report:${at}${body?.code ? CODE + body.code : ""}`] : []),
      ...(run ? [`report:${run}`] : []),
    ]
      .filter((id) => {
        const p = placementOf(id.replace(/^report:/, "").split(CODE)[0]);
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
  text,
}: {
  id: string;
  rank: 1 | 2;
  reporting?: boolean;
  /** What names it instead of its own name (a refusal's code). */
  text?: string;
}) {
  const p = placementOf(id);
  const found = partOf(id);
  const part = useMemo(
    () => (found && text ? { ...found, label: text } : found),
    [found, text],
  );
  const size = rank === 2 ? 0.36 : reporting ? 0.42 : 0.32;
  const grow = reporting ? REPORT_GROW : PART_GROW;
  const h = p ? HEIGHT[p.shape] * (p.radius / FOOTPRINT[p.shape]) + 0.4 : 0;
  const beside = useMemo(
    () =>
      reporting && p
        ? new Beside(
            new Vector3(p.position[0], p.position[1] + h, p.position[2]),
            p.radius,
            grow,
            part?.label.length ?? 4,
            size,
          )
        : undefined,
    [reporting, p, h, grow, part, size],
  );
  const group = useDeclutter(`part:${id}`, {
    chars: part?.label.length ?? 4,
    lines: 1,
    size,
    grow,
    priority: rank === 2 ? 200 : reporting ? 250 : 120,
    beside,
  });
  if (!p || !part) return null;
  const [x, y, z] = p.position;
  return (
    <group position={[x, y, z]}>
      <group ref={group} position={[0, h, 0]}>
        <KeepSize distance={grow.distance} max={grow.max}>
          {/* A storage key is named only close in: from afar its mark and
              the body at it are enough. */}
          <Lod far={id.startsWith("storageKey:") ? KEY_NAME_FAR : Infinity}>
            <Billboard>
              {reporting ? (
                <BesideHalo beside={beside!}>
                  <Label
                    fontSize={size}
                    color={text ? TONE_COLORS.error : "#ffffff"}
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

/** Room kept clear around a name beside a halo (px). */
const ROOM = 8;
/** How far right on the window (device coordinates) a name may end. */
const EDGE = 0.97;
const right = new Vector3();
const up = new Vector3();
const end = new Vector3();

/** The material of a name drawn over everything: it is not hidden by depth. */
const ON_TOP = new MeshBasicMaterial({
  depthTest: false,
  depthWrite: false,
  transparent: true,
  toneMapped: false,
});

/**
 * Where the name of a part reporting a step goes: just right of its halo
 * (`haloRadius`); just left of it when the name would cross the window's
 * right edge; below the halo when the declutter pass finds either side
 * covering a more important name.
 */
export class Beside {
  mode: "side" | "below" = "side";
  constructor(
    readonly at: Vector3,
    readonly radius: number,
    readonly grow: { distance: number; max: number },
    readonly chars: number,
    readonly size: number,
  ) {}
  /**
   * The name's left end, along the camera's right and up from `at` (world
   * units), its length, and the scale of its `KeepSize` group.
   */
  offset(camera: Camera, mode = this.mode) {
    const d = camera.position.distanceTo(this.at);
    const scale = Math.min(this.grow.max, Math.max(1, d / this.grow.distance));
    const beside = haloRadius(this.radius, d) * 1.15;
    const across = (this.chars * 0.53 * this.size + 0.1) * scale;
    if (mode === "below")
      return { x: -across / 2, y: -beside * 0.8, across, scale };
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    end
      .copy(this.at)
      .addScaledVector(right, beside + across)
      .project(camera);
    // Past the window's right edge: on the left of the halo instead.
    return {
      x: end.x > EDGE ? -(beside + across) : beside,
      y: 0,
      across,
      scale,
    };
  }
  /** The name's box on the window, in pixels, placed by `mode`. */
  rect(
    camera: Camera,
    view: { width: number; height: number },
    mode: "side" | "below",
  ): [number, number, number, number] {
    const o = this.offset(camera, mode);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    const half = this.size * o.scale * 0.6;
    const px = (v: Vector3) => [
      (v.x * 0.5 + 0.5) * view.width,
      (-v.y * 0.5 + 0.5) * view.height,
    ];
    const corner = (dx: number, dy: number) =>
      px(
        end
          .copy(this.at)
          .addScaledVector(right, o.x + dx)
          .addScaledVector(up, o.y - 0.2 * o.scale + dy)
          .project(camera),
      );
    const [x0, y0] = corner(0, half);
    const [x1, y1] = corner(o.across, -half);
    return [
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1),
    ];
  }
}

/** Puts what it holds where its {@link Beside} says. */
function BesideHalo({
  beside,
  children,
}: {
  beside: Beside;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g) return;
    const o = beside.offset(camera);
    g.position.set(o.x / o.scale, o.y / o.scale, 0);
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
              id={id.slice("report:".length).split(CODE)[0]}
              text={id.split(CODE)[1]}
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
