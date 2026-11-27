/**
 * The rows of the tables, as cards on their vaults. A row rises in when
 * inserted, flashes when updated, and sinks away in red when deleted. A table
 * with a state field colors its cards by state, as the presentation says.
 */
import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { Color, MathUtils, type Group, type MeshStandardMaterial } from "three";
import { DELETE_FADE, type RowState } from "../model/playback.ts";
import { fill } from "../presentation.ts";
import { currentState, hover, usePlayback, world } from "../store.ts";
import { Label } from "./Label.tsx";
import { Lod } from "./Lod.tsx";
import { partOf, placementOf } from "./look.ts";
import { isDrag } from "./clicks.ts";
import { DELETED_COLOR } from "./palette.ts";

const CARD = { width: 1.0, depth: 0.68, gap: 0.12, columns: 3, perLayer: 9 };

/** A signature of every row's identity and state, to re-render only on change. */
function useTables(): [string, RowState[]][] {
  const signature = usePlayback((s) => {
    void s.time;
    return [...currentState().tables]
      .map(
        ([t, rows]) =>
          `${t}=${rows.map((r) => `${r.id}:${r.state ?? ""}:${r.deletedAt ?? ""}:${r.changedAt}`).join(",")}`,
      )
      .join("|");
  });
  return useMemo(() => {
    void signature;
    return [...currentState().tables];
  }, [signature]);
}

export function Rows() {
  const tables = useTables();
  return (
    <>
      {tables.map(([table, rows]) => {
        const p = placementOf(table);
        if (!p) return null;
        return (
          <group key={table} position={p.position}>
            {rows.map((row) => (
              <RowCard key={row.id} table={table} row={row} color={p.color} />
            ))}
          </group>
        );
      })}
    </>
  );
}

function RowCard({
  table,
  row,
  color,
}: {
  table: string;
  row: RowState;
  color: string;
}) {
  const look = world.presentation.tables?.[table];
  const group = useRef<Group>(null);
  const body = useRef<MeshStandardMaterial>(null);
  const select = usePlayback((s) => s.select);
  const selected = usePlayback(
    (s) =>
      s.selected?.type === "row" &&
      s.selected.table === table &&
      s.selected.id === row.id,
  );
  const stateLook = row.state ? look?.states?.[row.state] : undefined;
  const target = useMemo(
    () => new Color(stateLook?.color ?? color),
    [stateLook, color],
  );
  const current = useRef(target.clone());
  const deleted = useMemo(() => new Color(DELETED_COLOR), []);
  const white = useMemo(() => new Color("#ffffff"), []);
  const slot = row.slot % CARD.perLayer;
  const layer = Math.floor(row.slot / CARD.perLayer);
  const col = slot % CARD.columns;
  const line = Math.floor(slot / CARD.columns);
  const x = (col - (CARD.columns - 1) / 2) * (CARD.width + CARD.gap);
  const z = (line - 1) * (CARD.depth + CARD.gap);
  const title = look?.title
    ? fill(look.title, row.doc) || `…${row.id.slice(-5)}`
    : `…${row.id.slice(-5)}`;
  const caption = look?.caption ? fill(look.caption, row.doc) : "";
  const retired = Boolean(stateLook?.retired);
  const ink = retired ? "#ffd9e2" : "#04070e";

  useFrame((_, delta) => {
    const g = group.current;
    const m = body.current;
    if (!g || !m) return;
    const { time } = currentState();
    const rise = MathUtils.clamp((time - row.insertedAt) / 0.7, 0, 1);
    const ease = 1 - Math.pow(1 - rise, 3);
    let y =
      0.62 + layer * 0.3 + MathUtils.lerp(1.6, 0, ease) + (selected ? 0.2 : 0);
    let scale = MathUtils.lerp(0.4, 1, ease);
    let opacity = 1;
    current.current.lerp(target, 1 - Math.exp(-delta * 5));
    m.color.copy(current.current).multiplyScalar(0.35);
    m.emissive.copy(current.current);
    let flash = Math.max(0, 1 - (time - row.changedAt) / 1.4);
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
      (retired ? 0.3 : 0.9) + flash * 1.6 + (selected ? 0.5 : 0);
    m.opacity = opacity;
    g.position.y = y;
    g.scale.setScalar(scale);
    g.rotation.z = retired ? -0.08 : 0;
  });

  const fields = Object.entries(row.doc)
    .filter(([k]) => !k.startsWith("_") && k !== look?.stateField)
    .slice(0, 3)
    .map(
      ([k, v]) =>
        `${k}: ${String(v).length > 14 ? `${String(v).slice(0, 12)}…` : String(v)}`,
    )
    .join("\n");

  return (
    <group
      ref={group}
      position={[x, 0.7, z]}
      onClick={(e) => {
        if (isDrag(e)) return;
        e.stopPropagation();
        select({ type: "row", table, id: row.id });
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        hover.label = `${partOf(table)?.label ?? table} row ${title}`;
      }}
      onPointerOut={() => (hover.label = "")}
    >
      <RoundedBox
        args={[CARD.width, 0.16, CARD.depth]}
        radius={0.05}
        smoothness={2}
      >
        <meshStandardMaterial
          ref={body}
          color="#111"
          emissive={target}
          emissiveIntensity={0.9}
          transparent
        />
      </RoundedBox>
      <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.085, 0]}>
        <Lod far={40}>
          <Label
            position={[0, 0.17, 0.01]}
            fontSize={0.17}
            color={ink}
            weight="bold"
            maxWidth={CARD.width - 0.08}
          >
            {title}
          </Label>
          <Label
            position={[0, 0.0, 0.01]}
            fontSize={0.1}
            color={ink}
            weight="bold"
            letterSpacing={0.08}
          >
            {(row.deletedAt !== undefined
              ? "deleted"
              : (row.state ?? "")
            ).toUpperCase()}
          </Label>
        </Lod>
        <Lod far={12}>
          <Label
            position={[0, -0.18, 0.01]}
            fontSize={0.065}
            color={ink}
            weight="mono"
            maxWidth={CARD.width - 0.08}
            textAlign="center"
          >
            {caption ? `${caption}\n${fields}` : fields || "{ }"}
          </Label>
        </Lod>
      </group>
    </group>
  );
}
