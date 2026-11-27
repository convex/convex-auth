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
import { useEffect, useMemo, useRef, useState } from "react";
import { PerspectiveCamera, Vector3, type Group } from "three";
import { FOOTPRINT } from "../layout/islands.ts";
import type { IslandPlacement } from "../layout/types.ts";
import { currentState, usePlayback, world } from "../store.ts";
import { highlightOf } from "./highlight.ts";
import { actingModules, HALO_ON_SCREEN } from "./Browser.tsx";
import { KeepSize, Label } from "./Label.tsx";
import { HEIGHT, partOf, placementOf } from "./look.ts";

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
function useActing(): string[] {
  const [acting, setActing] = useState<string[]>([]);
  const last = useRef({ t: -1, key: "" });
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current.t < 0.1) return;
    last.current.t = clock.elapsedTime;
    const state = currentState();
    const ids = new Set<string>(state.active.keys());
    // The module reporting the newest step: its name beside its halo.
    const now = actingModules(world.timeline.clientSteps, state.time).now;
    if (now) ids.add(`report:${now}`);
    for (const t of state.travellers) {
      ids.add(t.progress < 0.5 ? t.movement.from : t.movement.to);
    }
    const list = [...ids]
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
          <Billboard>
            <Label
              fontSize={size}
              color="#ffffff"
              // Beside the halo, which is HALO_ON_SCREEN of the distance
              // across: the same in this group's units.
              anchorX={reporting ? "left" : "center"}
              position={
                reporting
                  ? [HALO_ON_SCREEN * grow.distance * 1.15, -0.2, 0]
                  : undefined
              }
              weight={rank === 2 ? "bold" : "regular"}
              outlineWidth={0.025}
              outlineColor="#03050a"
            >
              {part.label}
            </Label>
          </Billboard>
        </KeepSize>
      </group>
    </group>
  );
}

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
