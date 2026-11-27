import { Label } from "../scene/Label.tsx";
import {
  CHANNELS,
  COOKIES,
  EXIT_Z,
  EXITS,
  FLIGHT,
  LOCAL,
  PAGE,
  extraExit,
  type Spot,
  type Vec3,
} from "./layout.ts";
import { LOOK, MATTE, mix } from "./look.ts";
import type {
  Exit,
  FlightAt,
  SecretInfo,
  SlotAt,
  StageAt,
  StageModel,
} from "./model.ts";
import { Container, Near, TopLabel, grid, selectOnClick } from "./Floor.tsx";
import { useStage, type Selection } from "./store.ts";

const useSelected = (match: (s: Selection | null) => boolean) =>
  useStage((s) => match(s.selection));

/** The elements the person used, standing on the page; lit when just used. */
function ElementTiles({ at }: { at: StageAt }) {
  const n = at.elements.length;
  if (n === 0) return null;
  const inner: Spot = { ...PAGE, w: PAGE.w * 0.8 };
  const span = inner.w / Math.max(n, 6);
  return (
    <group>
      {at.elements.map(({ element, lit }) => {
        const x = inner.x - inner.w / 2 + (element.order + 0.5) * span;
        return (
          <Tile
            key={element.key}
            at={[x, PAGE.h, PAGE.z - 2]}
            w={span * 0.8}
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
  at,
  w,
  lit,
  label,
  k,
  button,
}: {
  at: Vec3;
  w: number;
  lit: number;
  label: string;
  k: string;
  button: boolean;
}) {
  const selected = useSelected((s) => s?.type === "element" && s.key === k);
  const h = button ? 3 : 1.8;
  const lift = lit * 3;
  return (
    <group position={[at[0], at[1] + lift, at[2]]}>
      <mesh
        position={[0, h / 2, 0]}
        {...selectOnClick({ type: "element", key: k })}
      >
        <boxGeometry args={[w, h, 12]} />
        <meshStandardMaterial
          color={selected ? LOOK.active : mix(LOOK.item, LOOK.active, lit)}
          {...MATTE}
        />
      </mesh>
      <Near at={at} within={160}>
        <TopLabel
          at={[0, h + 0.05, 5]}
          size={Math.min(w / 6, 2.6)}
          maxWidth={w}
        >
          {label}
        </TopLabel>
      </Near>
    </group>
  );
}

/** What a token's claims say, short. */
function claimText(key: string, value: unknown): string {
  if (
    (key === "exp" || key === "iat" || key === "nbf") &&
    typeof value === "number"
  )
    return `${key} ${new Date(value * 1000).toISOString().slice(11, 19)}`;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return `${key} ${s.length > 18 ? `${s.slice(0, 16)}...` : s}`;
}

/** A key's value, inside the key: a token opens to its claims. */
function ValueBlock({
  spot,
  y,
  value,
  secret,
}: {
  spot: Spot;
  y: number;
  value: unknown;
  secret: SecretInfo | undefined;
}) {
  const text = secret
    ? `${secret.id}: ${secret.type === "jwt" ? "a JWT" : "an opaque token"}`
    : typeof value === "string"
      ? value.slice(0, 40)
      : JSON.stringify(value).slice(0, 40);
  const claims = secret?.claims ? Object.entries(secret.claims) : [];
  const g = grid(spot, claims.length, { margin: 0.08, front: 0.35, aspect: 3 });
  return (
    <Container
      spot={spot}
      y={y}
      name={text}
      color={secret ? LOOK.token : LOOK.item}
      labelSize={Math.min(spot.w / 12, 1)}
      labelFar={4}
    >
      {claims.map(([k, v], i) => {
        const p = g.at(i);
        return (
          <Container
            key={k}
            spot={{ x: p.x, z: p.z, w: g.cw * 0.9, d: g.rd * 0.7, h: 0.3 }}
            y={y + spot.h}
            name={claimText(k, v)}
            color={LOOK.item}
            labelSize={Math.min((g.cw * 0.9) / 11, 0.32)}
            labelFar={6}
          />
        );
      })}
    </Container>
  );
}

/** The keys a storage or the cookies hold, each holding its value. */
function SlotObjects({
  slots,
  spot,
  area,
  model,
  offset = 0,
  total,
  keys,
}: {
  /** The keys a step of the client code just read or wrote. */
  keys: StageAt["keys"];
  slots: SlotAt[];
  spot: Spot;
  area: "local" | "session" | "cookie";
  model: StageModel;
  /** Where the first slot goes: sessionStorage follows localStorage. */
  offset?: number;
  /** How many slots the area holds over the whole recording. */
  total: number;
}) {
  const g = grid(spot, Math.max(total, 4), { aspect: 2.4 });
  return (
    <group>
      {slots.map(({ slot, held, settled, leaving }) => {
        const p = g.at(slot.order + offset);
        const token = held.secrets.length > 0;
        const secret = token ? model.secrets.get(held.secrets[0]) : undefined;
        const w = g.cw * 0.86;
        const d = g.rd * 0.72;
        // Lands from just above and grows into place; leaves upward,
        // shrinking and fading.
        const lift = (1 - settled) * d * 0.6;
        const scale = 0.35 + 0.65 * settled;
        return (
          <group
            key={`${slot.key}@${held.eventId}`}
            position={[p.x, spot.h + lift, p.z]}
            scale={scale}
          >
            <KeyObject
              w={w}
              d={d}
              name={slot.name}
              area={area}
              k={slot.key}
              fresh={!leaving && settled < 1}
              lit={keys.get(slot.key)?.lit ?? 0}
              step={keys.get(slot.key)?.step.step ?? null}
              opacity={leaving ? settled : 1}
              value={held.value}
              secret={secret}
              token={token}
            />
          </group>
        );
      })}
    </group>
  );
}

function KeyObject({
  w,
  d,
  name,
  area,
  k,
  fresh,
  opacity,
  value,
  secret,
  token,
  lit,
  step,
}: {
  /** How lit by a step of the client code that read or wrote it. */
  lit: number;
  step: string | null;
  w: number;
  d: number;
  name: string;
  area: "local" | "session" | "cookie";
  k: string;
  fresh: boolean;
  opacity: number;
  value: unknown;
  secret: SecretInfo | undefined;
  token: boolean;
}) {
  const select: Selection = { type: "slot", area, key: k };
  const selected = useSelected(
    (s) => s?.type === "slot" && s.area === area && s.key === k,
  );
  const h = 2.2;
  const color =
    selected || fresh
      ? LOOK.active
      : mix(token ? LOOK.token : LOOK.item, LOOK.active, lit);
  // Positions here are relative to the key's group.
  const size = Math.max(w, d);
  return (
    <group name={`key:${k}`}>
      <mesh position={[0, h / 2, 0]} {...selectOnClick(select)}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          color={color}
          transparent={opacity < 1}
          opacity={opacity}
          {...MATTE}
        />
      </mesh>
      {lit > 0 && step && (
        <Near at={[0, 0, 0]} within={size * 7}>
          <Label
            position={[0, h + size * 0.25, 0]}
            anchorY="bottom"
            fontSize={Math.min(w / 12, 1.4)}
            color={LOOK.text}
            billboard
          >
            {step}
          </Label>
        </Near>
      )}
      <Near at={[0, 0, 0]} within={size * 7} name={`label:${k}`}>
        <TopLabel
          at={[0, h + 0.05, d / 2 - 0.3]}
          size={Math.min(w / 14, 1.4)}
          maxWidth={w * 0.95}
        >
          {name}
        </TopLabel>
      </Near>
      <Near at={[0, 0, 0]} within={size * 3} name={`value:${k}`}>
        <ValueBlock
          spot={{ x: 0, z: -d * 0.12, w: w * 0.8, d: d * 0.5, h: 0.8 }}
          y={h}
          value={value}
          secret={secret}
        />
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
function flightPosition(f: FlightAt, exits: Exit[]): Vec3 {
  const ch = CHANNELS[f.flight.via];
  const lane = (f.phase === "in" ? 1 : -1) * ch.width * 0.25;
  const ex = exitX(exits, f.flight.exit);
  // Along its channel to the front edge, then to the exit.
  const a: [number, number] = [ch.x + lane, ch.from];
  const b: [number, number] = [ch.x + lane, ch.to];
  const c: [number, number] = [ex + lane, EXIT_Z - 4];
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  let dd = f.along * (l1 + l2);
  let x: number;
  let z: number;
  if (dd <= l1) {
    x = a[0] + ((b[0] - a[0]) * dd) / l1;
    z = a[1] + ((b[1] - a[1]) * dd) / l1;
  } else {
    dd -= l1;
    x = b[0] + ((c[0] - b[0]) * dd) / Math.max(l2, 1e-6);
    z = b[1] + ((c[1] - b[1]) * dd) / Math.max(l2, 1e-6);
  }
  const level = f.flight.stack % 6;
  const column = Math.floor(f.flight.stack / 6);
  return [
    x + column * FLIGHT.size * 1.2 * Math.sign(lane),
    FLIGHT.y + level * FLIGHT.size * 1.25,
    z,
  ];
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
  const size = f.flight.via === "http" ? FLIGHT.httpSize : FLIGHT.size;
  const p = flightPosition(f, exits);
  return (
    <group position={p}>
      <mesh {...selectOnClick({ type: "flight", id })}>
        <boxGeometry args={[size, size, size]} />
        <meshStandardMaterial color={color} {...MATTE} />
      </mesh>
      <Near at={[0, 0, 0]} within={60}>
        <Label
          position={[0, size * 0.7, 0]}
          anchorY="bottom"
          fontSize={1.2}
          color={LOOK.text}
          billboard
        >
          {f.flight.label}
        </Label>
      </Near>
    </group>
  );
}

/** What moves: only what the recording shows happening at this time. */
export function Activity({ at, model }: { at: StageAt; model: StageModel }) {
  return (
    <group>
      <ElementTiles at={at} />
      <Near at={[LOCAL.x, 0, LOCAL.z]} within={2000}>
        <SlotObjects
          slots={at.local}
          spot={LOCAL}
          area="local"
          model={model}
          keys={at.keys}
          total={model.local.length + model.session.length}
        />
        <SlotObjects
          slots={at.session}
          spot={LOCAL}
          area="session"
          model={model}
          keys={at.keys}
          offset={model.local.length}
          total={model.local.length + model.session.length}
        />
        <SlotObjects
          slots={at.cookies}
          spot={COOKIES}
          area="cookie"
          model={model}
          keys={at.keys}
          total={model.cookies.length}
        />
      </Near>
      {at.flights.map((f) => (
        <FlightObject key={f.flight.id} f={f} exits={model.exits} />
      ))}
    </group>
  );
}
