/**
 * The text of the world, by distance:
 *
 * - From afar, island names. Once the camera is on an island, its name
 *   steps aside for the names of its parts.
 * - Nearer, the names of the parts on the islands around the camera. Only
 *   those islands mount their labels, so the cost of text stays bounded.
 * - Close up, the source location under each part, and the fields of tables.
 *
 * One declutter pass hides any label that would cover a more important one on
 * screen: the selection first, then the parts its links reach, the focus,
 * larger islands, and the rest. The selected part and the parts its links
 * reach are always mounted.
 */
import { Billboard } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { PerspectiveCamera, Vector3, type Group } from "three";
import { FOOTPRINT } from "../layout/islands.ts";
import type { IslandPlacement } from "../layout/types.ts";
import { usePlayback, world } from "../store.ts";
import { highlightOf } from "./highlight.ts";
import { KeepSize, Label } from "./Label.tsx";
import { Lod } from "./Lod.tsx";
import { HEIGHT, nounOfPart, partOf, placementOf } from "./look.ts";

const islands = world.layout.islands;
const focus = world.presentation.focus;

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

const ISLAND_GROW = { distance: 40, max: 2.2 };
const PART_GROW = { distance: 22, max: 2.6 };

function islandLabelSize(i: IslandPlacement) {
  return i.depth ? 0.6 + i.radius * 0.04 : 0.9 + i.radius * 0.05;
}

function IslandLabel({ island }: { island: IslandPlacement }) {
  const text = partOf(island.id)?.label ?? island.id;
  const children = islands.filter((i) => i.parentIsland === island.id).length;
  const sub = `${nounOfPart(island.id).toUpperCase()}  ·  ${island.members.length + children}`;
  const size = islandLabelSize(island);
  const group = useDeclutter(`island:${island.id}`, {
    chars: Math.max(text.length, sub.length * 0.6),
    lines: 2,
    size,
    grow: ISLAND_GROW,
    priority:
      50 + (island.id === focus ? 40 : 0) + island.radius - island.depth * 4,
    hideNear: island.radius * 1.3 + 8,
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
          <Label
            position={[0, -size * 0.85, 0]}
            fontSize={size * 0.42}
            color="#aeb9d6"
            letterSpacing={0.18}
            outlineWidth={size * 0.03}
            outlineColor="#03050a"
          >
            {sub}
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
        (e.hideNear !== undefined && d < e.hideNear)
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
        cy + px * (0.6 + (e.lines - 1) * 1.1),
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

/** The islands near enough to the camera to label their parts. */
function useNearIslands(): Set<string> {
  const { camera } = useThree();
  const [near, setNear] = useState<Set<string>>(new Set());
  const last = useRef({ t: 0, key: "" });
  useFrame(({ clock }) => {
    if (clock.elapsedTime - last.current.t < 0.3) return;
    last.current.t = clock.elapsedTime;
    const ids = islands
      .filter((i) => {
        at.set(...i.position);
        return (
          camera.position.distanceTo(at) < Math.max(40, i.radius * 3.2 + 12)
        );
      })
      .map((i) => i.id);
    const key = ids.join(",");
    if (key !== last.current.key) {
      last.current.key = key;
      setNear(new Set(ids));
    }
  });
  return near;
}

function PartLabel({ id, rank }: { id: string; rank: 0 | 1 | 2 }) {
  const p = placementOf(id);
  const part = partOf(id);
  const vault = p?.shape === "vault";
  const strong = rank > 0;
  const size = vault ? 0.3 : strong ? 0.34 : 0.27;
  const group = useDeclutter(`part:${id}`, {
    chars: vault ? 4 : (part?.label.length ?? 4),
    lines: part?.source && strong ? 2 : 1,
    size,
    grow: strong ? PART_GROW : undefined,
    priority: rank === 2 ? 200 : rank === 1 ? 120 : 10 + (p?.radius ?? 0),
  });
  if (!p || !part) return null;
  const [x, y, z] = p.position;
  const h = HEIGHT[p.shape] * (p.radius / FOOTPRINT[p.shape]) + 0.4;
  return (
    <group position={[x, y, z]}>
      {vault && (
        <Label
          position={[0, 0.26, 1.33]}
          fontSize={0.36}
          color={p.color}
          weight="bold"
          letterSpacing={0.1}
        >
          {part.label.toUpperCase()}
        </Label>
      )}
      <group ref={group} position={[0, vault ? 1.4 : h, vault ? -1.5 : 0]}>
        <KeepSize
          distance={strong ? PART_GROW.distance : 1e9}
          max={strong ? PART_GROW.max : 1}
        >
          <Billboard>
            {!vault && (
              <Label
                fontSize={size}
                color={strong ? "#ffffff" : "#dfe6ff"}
                weight={strong ? "bold" : "regular"}
                outlineWidth={0.025}
                outlineColor="#03050a"
              >
                {part.label}
              </Label>
            )}
            {part.source && (
              <Lod far={strong ? 40 : 9}>
                <Label
                  position={[0, vault ? 0 : -size * 0.95, 0]}
                  fontSize={0.16}
                  color="#8fa0c8"
                  weight="mono"
                  outlineWidth={0.015}
                  outlineColor="#03050a"
                >
                  {`${part.source.file}:${part.source.line}`}
                </Label>
              </Lod>
            )}
            {vault && part.fields && (
              <Lod far={14}>
                <Label
                  position={[0, 0.25 + part.fields.length * 0.11, 0]}
                  fontSize={0.17}
                  color="#c6d2f2"
                  weight="mono"
                  outlineWidth={0.015}
                  outlineColor="#03050a"
                  textAlign="center"
                >
                  {part.fields
                    .map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`)
                    .join("\n")}
                </Label>
              </Lod>
            )}
          </Billboard>
        </KeepSize>
      </group>
    </group>
  );
}

/** The names of the groups of an island that share a parent from elsewhere. */
function ClusterLabels({ island }: { island: IslandPlacement }) {
  return (
    <>
      {island.clusters.map((c) => (
        <Label
          key={c.id}
          position={[
            c.center[0],
            c.center[1] + 0.05,
            c.center[2] + c.radius + 0.3,
          ]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.55}
          color={placementOf(c.id)?.color ?? "#9fb6ff"}
          weight="bold"
          letterSpacing={0.12}
        >
          {(partOf(c.id)?.label ?? c.id).toUpperCase()}
        </Label>
      ))}
    </>
  );
}

export function Labels() {
  const near = useNearIslands();
  const selected = usePlayback((s) => s.selected);
  const ranked = useMemo(() => {
    const h = highlightOf(selected);
    const ranks = new Map<string, 1 | 2>();
    if (!h.island) {
      for (const id of h.linked.keys()) ranks.set(id, 1);
      for (const id of h.covered) ranks.set(id, 2);
    }
    // Callers and other parts off the islands are always named.
    for (const p of world.layout.parts.values())
      if (p.shape !== "island" && !p.island && !ranks.has(p.id))
        ranks.set(p.id, 1);
    return [...ranks]
      .filter(([id]) => placementOf(id)?.shape !== "island")
      .slice(0, 200);
  }, [selected]);
  const nearMembers = useMemo(() => {
    const strong = new Set(ranked.map(([id]) => id));
    return islands
      .filter((i) => near.has(i.id))
      .flatMap((i) => i.members.filter((m) => !strong.has(m)));
  }, [near, ranked]);
  return (
    <>
      <Declutter />
      {islands.map((i) => (
        <IslandLabel key={i.id} island={i} />
      ))}
      {islands
        .filter((i) => near.has(i.id))
        .map((i) => (
          <ClusterLabels key={i.id} island={i} />
        ))}
      {nearMembers.map((id) => (
        <PartLabel key={id} id={id} rank={0} />
      ))}
      {ranked.map(([id, rank]) => (
        <PartLabel key={id} id={id} rank={rank} />
      ))}
    </>
  );
}
