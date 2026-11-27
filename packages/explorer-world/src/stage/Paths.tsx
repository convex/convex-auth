/**
 * The path of what the client did, drawn: a traveller for each leg on its
 * way (`paths.ts`), with a trail behind it back to where it left; a ring
 * where a beat just happened, with its name; and a faint dashed "then"
 * between two beats in a row that the recording does not link.
 *
 * Travellers, rings and their names keep about the same size on the
 * window at any distance, so a path can be followed from the default view
 * and still points at one module or one key from close in.
 *
 * @module
 */
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import { DoubleSide, Vector3, type Group } from "three";
import { Label } from "../scene/Label.tsx";
import { FLIGHT, type Vec3 } from "./layout.ts";
import { LOOK, MATTE } from "./look.ts";
import { Near } from "./Floor.tsx";
import type { StageAt } from "./model.ts";
import { placeId, type LegAt, type Place } from "./paths.ts";
import {
  channelPoint,
  exitX,
  placePoint,
  type PlaceContext,
} from "./places.ts";

const seen = new Vector3();

/**
 * Scales its children with the distance to the camera, so that they keep
 * about the same size on the window: `k` world units per metre of distance,
 * between `min` and `max` times.
 */
function Sized({
  at,
  k,
  min = 0.15,
  max = 14,
  children,
  name,
}: {
  at: Vec3;
  k: number;
  min?: number;
  max?: number;
  children: ReactNode;
  name?: string;
}) {
  const g = useRef<Group>(null);
  useFrame(({ camera }) => {
    const group = g.current;
    if (!group) return;
    seen.set(...at);
    const d = camera.position.distanceTo(seen);
    group.scale.setScalar(Math.min(max, Math.max(min, d * k)));
  });
  return (
    <group ref={g} position={at} name={name}>
      {children}
    </group>
  );
}

/** Size on the window: about this share of the distance. */
const TRAVELLER = 0.014;
const RING = 0.02;
const NAME = 0.013;
/** Within this distance every place shows its newest beat's name. */
const NAMES_NEAR = 320;

/** A point of a leg, `k` from its start (0) to its far end (1). */
function legPoint(leg: LegAt["leg"], k: number, ctx: PlaceContext): Vec3 {
  if (leg.call) {
    const [x, z] = channelPoint(
      leg.call.via,
      exitX(ctx.model.exits, leg.call.exit),
      k,
      0,
    );
    return [x, FLIGHT.y + 3, z];
  }
  const a = placePoint(leg.from, ctx);
  const b = placePoint(leg.to, ctx);
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const lift = Math.sin(Math.PI * k) * Math.min(len * 0.12, 14);
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k + lift,
    a[2] + (b[2] - a[2]) * k,
  ];
}

/** The trail of a leg: from where it left to where it is now. */
function trail(l: LegAt, ctx: PlaceContext): Vec3[] {
  const pts: Vec3[] = [];
  const n = 18;
  if (l.phase === "in") {
    // Back from the exit: the way it came back so far.
    for (let i = 0; i <= n; i++)
      pts.push(legPoint(l.leg, 1 - (1 - l.along) * (i / n), ctx));
    return pts;
  }
  for (let i = 0; i <= n; i++)
    pts.push(legPoint(l.leg, l.along * (i / n), ctx));
  return pts;
}

function Traveller({ l, ctx }: { l: LegAt; ctx: PlaceContext }) {
  const p = legPoint(l.leg, l.along, ctx);
  const pts = trail(l, ctx);
  const call = l.leg.kind === "call";
  const failed = l.leg.call?.failed ?? false;
  const color = failed ? LOOK.failed : LOOK.traveller;
  return (
    <group name={`leg:${l.leg.id}`}>
      {pts.length > 1 && (
        <Line
          points={pts}
          color={color}
          lineWidth={call ? 4 : 3}
          transparent
          opacity={0.75}
        />
      )}
      <Sized at={p} k={TRAVELLER} name={`traveller:${l.leg.id}`}>
        <mesh>
          {call ? (
            <boxGeometry args={[1.3, 1.3, 1.3]} />
          ) : (
            <sphereGeometry args={[0.7, 20, 14]} />
          )}
          <meshStandardMaterial color={color} {...MATTE} />
        </mesh>
        <Label
          position={[0, 1.2, 0]}
          anchorY="bottom"
          fontSize={NAME / TRAVELLER}
          color={LOOK.text}
          weight="bold"
          billboard
        >
          {l.leg.kind === "call"
            ? l.leg.label
            : l.leg.kind === "read"
              ? "read"
              : l.leg.kind}
        </Label>
      </Sized>
    </group>
  );
}

/** A ring where a beat just happened, and its name. */
function BeatRing({
  at,
  lit,
  label,
  id,
  newest,
}: {
  at: Vec3;
  lit: number;
  label: string | null;
  id: string;
  /** The newest beat of all: its name shows from afar too. */
  newest: boolean;
}) {
  const grow = 0.6 + (1 - lit) * 0.9;
  return (
    <Sized at={[at[0], at[1] + 0.15, at[2]]} k={RING} name={`beat:${id}`}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} scale={grow}>
        <ringGeometry args={[0.7, 1, 40]} />
        <meshBasicMaterial
          color={LOOK.traveller}
          transparent
          opacity={0.25 + 0.75 * lit}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {label && (
        // From afar the places of a district are a few pixels apart: only
        // the newest beat's name shows there; near, each place's does.
        <Near at={[0, 0, 0]} within={newest ? Infinity : NAMES_NEAR}>
          <Label
            position={[0, 0.9, 0]}
            anchorY="bottom"
            fontSize={NAME / RING}
            color={LOOK.text}
            weight="regular"
            billboard
          >
            {label}
          </Label>
        </Near>
      )}
    </Sized>
  );
}

const raised = (p: Vec3, by: number): Vec3 => [p[0], p[1] + by, p[2]];

/** The paths at the time shown. Nothing is drawn when nothing happens. */
export function Paths({ at, ctx }: { at: StageAt; ctx: PlaceContext }) {
  // The newest beat at each place: one ring and one name per place.
  const newest = new Map<string, StageAt["beats"][number]>();
  for (const b of at.beats) newest.set(placeId(b.beat.place), b);
  const last = [...at.beats]
    .reverse()
    .find((b) => beatName(b.beat.place, b.beat.label, b.beat.source));
  return (
    <group name="paths">
      {at.thens.map(({ then, fresh }) => (
        <Line
          key={then.id}
          name={then.id}
          points={[
            raised(placePoint(then.from, ctx), 1.5),
            raised(placePoint(then.to, ctx), 1.5),
          ]}
          color={LOOK.then}
          lineWidth={1.5}
          dashed
          dashSize={3}
          gapSize={3}
          transparent
          opacity={0.7 * fresh}
        />
      ))}
      {[...newest.values()].map(({ beat, lit }) => (
        <BeatRing
          key={placeId(beat.place)}
          id={beat.id}
          at={placePoint(beat.place, ctx)}
          lit={lit}
          label={beatName(beat.place, beat.label, beat.source)}
          newest={beat === last?.beat}
        />
      ))}
      {at.legs.map((l) => (
        <Traveller key={l.leg.id} l={l} ctx={ctx} />
      ))}
    </group>
  );
}

/** The name a beat shows by its ring: a step's name; others say nothing. */
function beatName(place: Place, label: string, source: string): string | null {
  if (source === "step") return label;
  if (source === "input" && place.type === "element") return label;
  return null;
}
