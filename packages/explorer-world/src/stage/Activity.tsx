import { Label } from "../scene/Label.tsx";
import {
  COOKIES,
  EXIT_Z,
  EXITS,
  FLIGHT_Y,
  LOCAL,
  PAGE,
  PIPES,
  extraExit,
  type Spot,
} from "./layout.ts";
import { LOOK, MATTE } from "./look.ts";
import type { Exit, FlightAt, StageAt, SlotAt, StageModel } from "./model.ts";
import { Near, selectOnClick } from "./Floor.tsx";
import { useStage } from "./store.ts";

const mix = (a: string, b: string, k: number) => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const c = (s: number) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * k);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
};

function useSelected(
  match: (s: ReturnType<typeof useStage.getState>["selection"]) => boolean,
) {
  return useStage((s) => match(s.selection));
}

/** The elements the person used, as tiles on the page; lit when just used. */
function ElementTiles({ at }: { at: StageAt }) {
  const n = at.elements.length;
  if (n === 0) return null;
  const span = 10.5;
  const w = Math.min(2.2, span / n - 0.2);
  return (
    <group position={[PAGE.x, PAGE.h, PAGE.z - 0.1]}>
      {at.elements.map(({ element, lit }) => {
        const x = -span / 2 + (element.order + 0.5) * (span / Math.max(n, 1));
        return (
          <Tile
            key={element.key}
            x={x}
            w={w}
            lit={lit}
            label={element.label}
            k={element.key}
            button={element.tag === "button" || element.tag === "a"}
          />
        );
      })}
    </group>
  );
}

function Tile({
  x,
  w,
  lit,
  label,
  k,
  button,
}: {
  x: number;
  w: number;
  lit: number;
  label: string;
  k: string;
  button: boolean;
}) {
  const selected = useSelected((s) => s?.type === "element" && s.key === k);
  const h = button ? 0.5 : 0.3;
  return (
    <group position={[x, lit * 0.35, 0]}>
      <mesh
        position={[0, h / 2, 0]}
        {...selectOnClick({ type: "element", key: k })}
      >
        <boxGeometry args={[w, h, 1.2]} />
        <meshStandardMaterial
          color={selected ? LOOK.active : mix(LOOK.item, LOOK.active, lit)}
          {...MATTE}
        />
      </mesh>
      <Near at={[x, 0, PAGE.z]} distance={20}>
        <Label
          position={[0, h + 0.02, 0.15]}
          rotation={[-Math.PI / 2 + 0.4, 0, 0]}
          fontSize={0.3}
          color={LOOK.text}
          maxWidth={w}
        >
          {label}
        </Label>
      </Near>
    </group>
  );
}

/** The objects a storage or the cookies hold, on their tray. */
function SlotObjects({
  slots,
  spot,
  area,
  model,
  offset = 0,
}: {
  slots: SlotAt[];
  spot: Spot;
  area: "local" | "session" | "cookie";
  model: StageModel;
  /** Where the first slot goes: sessionStorage follows localStorage. */
  offset?: number;
}) {
  const cols = 3;
  const cw = (spot.w - 3.2) / cols;
  const rowD = 1.05;
  return (
    <group position={[spot.x, spot.h, spot.z]}>
      {slots.map(({ slot, held, settled, leaving }) => {
        const order = slot.order + offset;
        const col = order % cols;
        const row = Math.floor(order / cols);
        const x = -spot.w / 2 + 3 + (col + 0.5) * cw;
        const z = -spot.d / 2 + 0.7 + row * rowD;
        const token = held.secrets.length > 0;
        const secret = token ? model.secrets.get(held.secrets[0]) : undefined;
        const name = token
          ? `${slot.name}: ${held.secrets.join(", ")}${secret ? ` (${secret.type === "jwt" ? "JWT" : "opaque"})` : ""}`
          : slot.name;
        // Lands from just above and grows into place; leaves upward,
        // shrinking and fading.
        const lift = (1 - settled) * 1.3;
        return (
          <SlotObject
            key={`${slot.key}@${held.eventId}`}
            position={[x, lift, z]}
            w={cw - 0.25}
            token={token}
            opacity={leaving ? settled : 1}
            scale={0.35 + 0.65 * settled}
            name={name}
            area={area}
            k={slot.key}
            fresh={!leaving && settled < 1}
          />
        );
      })}
    </group>
  );
}

function SlotObject({
  position,
  w,
  token,
  opacity,
  scale,
  name,
  area,
  k,
  fresh,
}: {
  position: [number, number, number];
  w: number;
  token: boolean;
  opacity: number;
  scale: number;
  name: string;
  area: "local" | "session" | "cookie";
  k: string;
  fresh: boolean;
}) {
  const selected = useSelected(
    (s) => s?.type === "slot" && s.area === area && s.key === k,
  );
  const h = token ? 0.55 : 0.35;
  return (
    <group position={position}>
      <mesh
        position={[0, (h * scale) / 2, 0]}
        scale={scale}
        {...selectOnClick({ type: "slot", area, key: k })}
      >
        <boxGeometry args={[w, h, 0.8]} />
        <meshStandardMaterial
          color={
            selected || fresh ? LOOK.active : token ? LOOK.token : LOOK.item
          }
          transparent={opacity < 1}
          opacity={opacity}
          {...MATTE}
        />
      </mesh>
      <Near at={[position[0], 0, position[2]]} distance={22}>
        <Label
          position={[0, h + 0.02, 0.1]}
          rotation={[-Math.PI / 2 + 0.4, 0, 0]}
          fontSize={0.24}
          color={LOOK.text}
          maxWidth={w}
          textAlign="center"
        >
          {name}
        </Label>
      </Near>
    </group>
  );
}

function exitX(exits: Exit[], id: string): number {
  const fixed = EXITS[id];
  if (fixed) return fixed.x;
  const extra = exits.filter((e) => !(e.id in EXITS));
  return extraExit(
    Math.max(
      0,
      extra.findIndex((e) => e.id === id),
    ),
  ).x;
}

/** Where a message is along its way. */
function flightPosition(f: FlightAt, exits: Exit[]): [number, number, number] {
  const pipe = PIPES[f.flight.via];
  const lane = f.phase === "in" ? 0.32 : -0.32;
  const ex = exitX(exits, f.flight.exit);
  // From the client end of the pipe to its end at the edge, then to the exit.
  const a: [number, number] = [pipe.x + lane, pipe.from];
  const b: [number, number] = [pipe.x + lane, pipe.to];
  const c: [number, number] = [ex + lane, EXIT_Z - 0.6];
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  let d = f.along * (l1 + l2);
  let x: number;
  let z: number;
  if (d <= l1) {
    x = a[0] + ((b[0] - a[0]) * d) / l1;
    z = a[1] + ((b[1] - a[1]) * d) / l1;
  } else {
    d -= l1;
    x = b[0] + ((c[0] - b[0]) * d) / Math.max(l2, 1e-6);
    z = b[1] + ((c[1] - b[1]) * d) / Math.max(l2, 1e-6);
  }
  const level = f.flight.stack % 6;
  const column = Math.floor(f.flight.stack / 6);
  return [x + column * 0.55 * Math.sign(lane), FLIGHT_Y + level * 0.62, z];
}

function Flights({ at, exits }: { at: StageAt; exits: Exit[] }) {
  return (
    <group>
      {at.flights.map((f) => (
        <FlightObject key={f.flight.id} f={f} exits={exits} />
      ))}
    </group>
  );
}

function FlightObject({ f, exits }: { f: FlightAt; exits: Exit[] }) {
  const id = f.flight.id;
  const selected = useSelected((s) => s?.type === "flight" && s.id === id);
  const token = f.flight.secrets.length > 0;
  const color = selected
    ? LOOK.active
    : f.flight.failed
      ? LOOK.failed
      : token
        ? LOOK.token
        : f.phase === "in"
          ? LOOK.messageReceived
          : LOOK.message;
  const size = f.flight.via === "http" ? 0.62 : 0.46;
  return (
    <mesh
      position={flightPosition(f, exits)}
      {...selectOnClick({ type: "flight", id })}
    >
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial color={color} {...MATTE} />
    </mesh>
  );
}

/** What moves: only what the recording shows happening at this time. */
export function Activity({ at, model }: { at: StageAt; model: StageModel }) {
  return (
    <group>
      <ElementTiles at={at} />
      <SlotObjects slots={at.local} spot={LOCAL} area="local" model={model} />
      <SlotObjects
        slots={at.session}
        spot={LOCAL}
        area="session"
        model={model}
        offset={model.local.length}
      />
      <SlotObjects
        slots={at.cookies}
        spot={COOKIES}
        area="cookie"
        model={model}
      />
      <Flights at={at} exits={model.exits} />
    </group>
  );
}
