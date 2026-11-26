import { Edges, RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, MathUtils, type Group, type MeshStandardMaterial } from "three";
import { DELETE_FADE, type RowState } from "../model/playback.ts";
import type { TableDef } from "../model/types.ts";
import { currentState, hover, usePlayback } from "../store.ts";
import { Label } from "./Label.tsx";
import { ROW, type TableLayout } from "./layout.ts";
import { Lod } from "./Lod.tsx";
import { config } from "../store.ts";
import { isRetired, regionColorOf, stateColorOf } from "./look.ts";
import { DELETED_COLOR } from "./palette.ts";

/** The rows of a table that exist (or are dissolving) now, by id and state. */
function useRows(table: string): RowState[] {
  // Re-render when the set of rows or a state changes, not on every frame.
  const signature = usePlayback((s) => {
    void s.time;
    const rows = currentState().tables.get(table) ?? [];
    return rows
      .map(
        (r) => `${r.id}:${r.state ?? ""}:${r.deletedAt ?? ""}:${r.changedAt}`,
      )
      .join("|");
  });
  return useMemo(() => {
    void signature;
    return currentState().tables.get(table) ?? [];
  }, [signature, table]);
}

/** A table: a vault of dark glass whose rows are cards on its surface. */
export function TableVault({
  table,
  layout,
}: {
  table: TableDef;
  layout: TableLayout;
}) {
  const color = useMemo(
    () => new Color(regionColorOf(table.region)),
    [table.region],
  );
  const rows = useRows(table.id);
  const select = usePlayback((s) => s.select);
  const selected = usePlayback(
    (s) => s.selected?.type === "table" && s.selected.id === table.id,
  );
  const lines = Math.max(1, Math.ceil(rows.length / layout.columns));
  const depth = Math.max(
    layout.depth,
    lines * (ROW.depth + ROW.gap) + ROW.gap + 0.6,
  );
  const frame = useRef<MeshStandardMaterial>(null);

  useFrame(() => {
    if (frame.current) frame.current.emissiveIntensity = selected ? 0.5 : 0.12;
  });

  return (
    <group position={layout.position}>
      <group
        onClick={(e) => {
          e.stopPropagation();
          select({ type: "table", id: table.id });
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          hover.label = `${table.name} table`;
        }}
        onPointerOut={() => (hover.label = "")}
      >
        <RoundedBox
          args={[layout.width, 0.5, depth]}
          radius={0.18}
          smoothness={3}
          position={[0, 0.25, 0]}
        >
          <meshStandardMaterial
            ref={frame}
            color="#0b1222"
            emissive={color}
            emissiveIntensity={0.12}
            metalness={0.6}
            roughness={0.3}
          />
        </RoundedBox>
        <mesh position={[0, 0.505, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[layout.width - 0.3, depth - 0.3]} />
          <meshStandardMaterial
            color="#060a14"
            metalness={0.9}
            roughness={0.12}
          />
          <Edges color={color} />
        </mesh>
      </group>
      <Lod far={62}>
        <Label
          position={[0, 0.26, depth / 2 + 0.02]}
          fontSize={0.34}
          color={color}
          weight="bold"
          letterSpacing={0.14}
        >
          {table.name.toUpperCase()}
        </Label>
      </Lod>
      <Lod far={70} near={15}>
        <Label
          billboard
          position={[0, 2.2, -depth / 2 + 0.2]}
          fontSize={0.42}
          color="#dfe6ff"
          outlineWidth={0.03}
          outlineColor="#03050a"
        >
          {`${table.name}  ·  ${rows.filter((r) => r.deletedAt === undefined).length}`}
        </Label>
      </Lod>
      {rows.map((row) => (
        <RowCard
          key={row.id}
          table={table}
          row={row}
          layout={layout}
          lines={lines}
          color={color}
        />
      ))}
    </group>
  );
}

function rowColor(table: TableDef, row: RowState, base: Color): Color {
  const color = table.stateField ? stateColorOf(row.state) : undefined;
  if (color) return new Color(color);
  return base;
}

function RowCard({
  table,
  row,
  layout,
  lines,
  color,
}: {
  table: TableDef;
  row: RowState;
  layout: TableLayout;
  lines: number;
  color: Color;
}) {
  const group = useRef<Group>(null);
  const body = useRef<MeshStandardMaterial>(null);
  const current = useRef(rowColor(table, row, color).clone());
  const select = usePlayback((s) => s.select);
  const selected = usePlayback(
    (s) =>
      s.selected?.type === "row" &&
      s.selected.table === table.id &&
      s.selected.id === row.id,
  );
  const col = row.slot % layout.columns;
  const line = Math.floor(row.slot / layout.columns);
  const x =
    -((layout.columns - 1) * (ROW.width + ROW.gap)) / 2 +
    col * (ROW.width + ROW.gap);
  const z =
    -((lines - 1) * (ROW.depth + ROW.gap)) / 2 + line * (ROW.depth + ROW.gap);
  const deleted = useMemo(() => new Color(DELETED_COLOR), []);
  const white = useMemo(() => new Color("#ffffff"), []);
  const target = rowColor(table, row, color);
  const featured = layout.featured;
  const title = row.label ?? `…${row.id.slice(-6)}`;
  const retired = isRetired(row.state);
  const ink = retired ? "#ffd9e2" : "#04070e";
  const fields = Object.entries(row.doc)
    .filter(([k]) => k !== table.stateField)
    .map(
      ([k, v]) =>
        `${k}: ${String(v).length > 22 ? `${String(v).slice(0, 20)}…` : String(v)}`,
    )
    .slice(0, 3)
    .join("\n");

  useFrame((_, delta) => {
    const g = group.current;
    const m = body.current;
    if (!g || !m) return;
    const { time } = currentState();
    const sinceInsert = time - row.insertedAt;
    const sinceChange = time - row.changedAt;
    // Rise in on insert.
    const rise = MathUtils.clamp(sinceInsert / 0.7, 0, 1);
    const ease = 1 - Math.pow(1 - rise, 3);
    let y = 0.5 + 0.18 + MathUtils.lerp(1.4, 0, ease) + (selected ? 0.25 : 0);
    let scale = MathUtils.lerp(0.4, 1, ease);
    let opacity = 1;
    current.current.lerp(target, 1 - Math.exp(-delta * 5));
    m.color.copy(current.current).multiplyScalar(0.35);
    m.emissive.copy(current.current);
    const dim = retired ? 0.35 : 1;
    let flash = Math.max(0, 1 - sinceChange / 1.4);
    if (row.deletedAt !== undefined) {
      const k = MathUtils.clamp((time - row.deletedAt) / DELETE_FADE, 0, 1);
      m.emissive.lerpColors(current.current, deleted, Math.min(1, k * 3));
      y -= k * 0.9;
      scale *= 1 - k * 0.6;
      opacity = 1 - k;
      flash = Math.max(0, 1 - k * 2.5);
    } else if (flash > 0) {
      m.emissive.lerp(white, flash * 0.6);
    }
    m.emissiveIntensity =
      (featured ? 0.95 : 0.7) * dim + flash * 1.6 + (selected ? 0.5 : 0);
    m.opacity = opacity;
    g.position.y = y;
    g.scale.setScalar(scale);
    g.rotation.z = retired ? -0.06 : 0;
  });

  return (
    <group
      ref={group}
      position={[x, 0.7, z]}
      onClick={(e) => {
        e.stopPropagation();
        select({ type: "row", table: table.id, id: row.id });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        hover.label = `${table.name} row ${title}`;
      }}
      onPointerOut={() => (hover.label = "")}
    >
      <RoundedBox
        args={[ROW.width, 0.22, ROW.depth]}
        radius={0.08}
        smoothness={2}
      >
        <meshStandardMaterial
          ref={body}
          color="#111"
          emissive={target}
          emissiveIntensity={0.8}
          transparent
          metalness={0.2}
          roughness={0.4}
        />
      </RoundedBox>
      <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.115, 0]}>
        <Lod far={featured ? 90 : 26}>
          <Label
            position={[featured ? -0.72 : 0, featured ? 0.08 : 0.28, 0.01]}
            fontSize={featured ? 0.7 : 0.3}
            color={ink}
            weight="bold"
          >
            {title}
          </Label>
        </Lod>
        {featured && (
          <Lod far={48}>
            <Label
              position={[-0.22, 0.2, 0.01]}
              fontSize={0.2}
              color={ink}
              weight="bold"
              letterSpacing={0.06}
              anchorX="left"
            >
              {(row.deletedAt !== undefined
                ? "deleted"
                : (row.state ?? "")
              ).toUpperCase()}
            </Label>
            <Label
              position={[-0.22, -0.06, 0.01]}
              fontSize={0.15}
              color={ink}
              anchorX="left"
            >
              {config.rowCaption?.(table.id, row.doc) ?? ""}
            </Label>
          </Lod>
        )}
        {row.deletedAt !== undefined && (
          <Label
            position={[0, 0, 0.3]}
            fontSize={featured ? 0.34 : 0.26}
            color="#ff3b5c"
            weight="bold"
            letterSpacing={0.12}
            outlineWidth={0.03}
            outlineColor="#1a0006"
          >
            DELETED
          </Label>
        )}
        <Lod far={14}>
          <Label
            position={[0, featured ? -0.5 : -0.2, 0.01]}
            fontSize={0.12}
            color={ink}
            weight="mono"
            maxWidth={ROW.width - 0.2}
            textAlign="center"
          >
            {fields || "{ }"}
          </Label>
        </Lod>
      </group>
    </group>
  );
}
