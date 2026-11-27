/**
 * The vast sample: a monumental screen with the sign-in page, the browser as
 * a territory in front of it, and the connections out to gates far off.
 * Content only: every part comes from the look's world kit, and the scene
 * names nothing about appearance.
 */
import { createContext, useContext, useMemo } from "react";
import type { Vector3 } from "three";
import type { V3 } from "../layout.ts";
import type { WorldParts } from "../look.ts";
import { useLook } from "../kit.tsx";
import { isWorldLook } from "../look.ts";
import { frameAt, ROUTES, type Frame } from "./motion.ts";
import { Reveal } from "./reveal.tsx";
import {
  DISTRICTS,
  GATES,
  SCREEN,
  TERRITORY,
  type District,
  type Piece,
} from "./world.ts";

function useWorld(): WorldParts {
  const look = useLook();
  if (!isWorldLook(look))
    throw new Error(`The look ${look.id} does not draw the vast sample.`);
  return look.world;
}

const FrameContext = createContext<Frame | null>(null);
const useFrameAt = () => useContext(FrameContext)!;

/** The size of a footprint, as one length: how near counts as near. */
const reach = (s: V3) => Math.sqrt(s[0] * s[2]);

/** The box a thing and what stands on it take. */
function boxOf(p: { position: V3; size: V3 }, above = 12): [V3, V3] {
  const [x, y, z] = p.position;
  const [w, h, d] = p.size;
  return [
    [x - w / 2, y, z - d / 2],
    [x + w / 2, y + h + above, z + d / 2],
  ];
}

/**
 * When a piece comes in, as [from, full] distances to its parent: a
 * district's own pieces as you come into the browser, what they hold once
 * you are inside the district (by its size, `R`), a token's claims only
 * close up.
 */
function revealFor(kind: Piece["kind"], R: number): [number, number] {
  switch (kind) {
    case "module":
    case "key":
      return [480, 340];
    case "claim":
      return [0.65 * R, 0.42 * R];
    default:
      return [1.45 * R, 1.0 * R];
  }
}

const local = (p: V3, at: V3): V3 => [p[0] - at[0], p[1] - at[1], p[2] - at[2]];

function PieceTree({
  piece,
  parent,
  origin,
  R,
}: {
  piece: Piece;
  parent: Piece | District;
  /** The size of its district, as one length. */
  R: number;
  /** Where the group this is drawn in stands, in the world. */
  origin: V3;
}) {
  const { Piece: Draw } = useWorld();
  const f = useFrameAt();
  const top = !("kind" in parent);
  const [from, full] = revealFor(
    top && piece.kind === "element" ? "module" : piece.kind,
    R,
  );
  // A key exists once the motion sets it.
  const exists = piece.kind === "key" ? (f.keys[piece.id] ?? 1) : 1;
  return (
    <Reveal
      at={local(piece.position, origin)}
      box={boxOf(parent)}
      from={from}
      full={full}
      scale={exists}
    >
      <Draw
        kind={piece.kind}
        id={piece.id}
        label={piece.label}
        note={piece.note}
        position={[0, 0, 0]}
        size={piece.size}
        active={f.active === piece.id}
      />
      {piece.children.map((c) => (
        <PieceTree
          key={c.id}
          piece={c}
          parent={piece}
          origin={piece.position}
          R={R}
        />
      ))}
    </Reveal>
  );
}

function DistrictView({ d }: { d: District }) {
  const { Place, Name } = useWorld();
  const f = useFrameAt();
  const r = reach(d.size);
  const front = d.position[2] + d.size[2] / 2;
  const narrow = d.size[0] < 40;
  // A channel is named at its back end, where it starts.
  const namePos: V3 = narrow
    ? [d.position[0], d.position[1] + 0.05, d.position[2] - d.size[2] / 2 - 3]
    : [d.position[0], d.position[1] + 0.05, front + 3];
  return (
    <>
      <Place
        kind="district"
        id={d.id}
        position={d.position}
        size={d.size}
        active={f.activeDistrict === d.id}
      />
      {/* Its name stands at its front edge, and only nearer than far out. */}
      <Reveal at={namePos} box={boxOf(d)} from={5 * r} full={3.5 * r}>
        <Name
          position={[0, 0, 0]}
          text={d.label}
          size={narrow ? 4 : 7}
          kind="place"
          flat={false}
        />
      </Reveal>
      <Reveal at={namePos} box={boxOf(d)} from={1.7 * r} full={1.15 * r}>
        <Name
          position={[0, 0, narrow ? -4 : 5.5]}
          text={d.note}
          size={narrow ? 1.4 : 2.2}
          kind="note"
          flat
        />
      </Reveal>
      {d.children.map((p) => (
        <PieceTree key={p.id} piece={p} parent={d} origin={[0, 0, 0]} R={r} />
      ))}
    </>
  );
}

export function VastScene({ time }: { time: number }) {
  const w = useWorld();
  const f = useMemo(() => frameAt(time), [time]);
  const trail = useMemo(() => {
    if (!f.trail || f.trail.u <= 0) return null;
    const curve = ROUTES[f.trail.route];
    const n = Math.max(2, Math.ceil(80 * f.trail.u));
    const points: Vector3[] = [];
    for (let i = 0; i <= n; i++)
      points.push(curve.getPointAt((i / n) * f.trail.u));
    return { points, kind: f.trail.kind };
  }, [f.trail]);
  const plateFront = TERRITORY.position[2] + TERRITORY.size[2] / 2;
  return (
    <FrameContext.Provider value={f}>
      <w.Ground />
      <w.Monument
        position={SCREEN.position}
        width={SCREEN.width}
        height={SCREEN.height}
        pageLift={SCREEN.pageLift}
        pressed={f.pressed}
      />
      <w.Place
        kind="territory"
        id={TERRITORY.id}
        position={TERRITORY.position}
        size={TERRITORY.size}
        active={false}
      />
      <w.Name
        position={[0, TERRITORY.size[1] + 0.05, plateFront - 12]}
        text={TERRITORY.label}
        size={12}
        kind="place"
        flat
      />
      <w.Name
        position={[0, TERRITORY.size[1] + 0.05, plateFront - 4]}
        text={TERRITORY.note}
        size={3.2}
        kind="note"
        flat
      />
      {DISTRICTS.map((d) => (
        <DistrictView key={d.id} d={d} />
      ))}
      {GATES.map((g) => (
        <w.Gate
          key={g.id}
          position={g.position}
          width={g.width}
          height={g.height}
          label={g.label}
          active={f.active === g.id}
        />
      ))}
      {trail && <w.Trail points={trail.points} kind={trail.kind} />}
      {f.carrier && (
        <w.Carrier
          position={f.carrier.position}
          kind={f.carrier.kind}
          opacity={f.carrier.opacity}
        />
      )}
      {f.tokens.map(
        (t, i) =>
          t && (
            <w.Carrier key={i} position={t.position} kind="token" opacity={1} />
          ),
      )}
    </FrameContext.Provider>
  );
}
