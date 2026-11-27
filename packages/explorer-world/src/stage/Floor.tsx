import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import { Vector3, type Group } from "three";
import { Label } from "../scene/Label.tsx";
import { isDrag } from "../scene/clicks.ts";
import type { StageLabels } from "../adapters/browserStage.ts";
import {
  CHANNELS,
  CLIENT,
  COOKIES,
  EXIT_HEIGHT,
  EXIT_Z,
  EXITS,
  LABEL_FAR,
  LOCAL,
  PAGE,
  REVEAL,
  TERRITORY,
  extraExit,
  type Spot,
  type Vec3,
} from "./layout.ts";
import { LOOK, MATTE } from "./look.ts";
import type { Exit, StageAt } from "./model.ts";
import type { ClientPart } from "./sources.ts";
import { useStage, type Selection } from "./store.ts";

const seen = new Vector3();

/**
 * Shows its children only while the camera is within `within` of `at` (and,
 * with `beyond`, farther than that): how a thing shows its insides as you
 * come near and hides them as you leave.
 */
export function Near({
  at,
  within,
  beyond = 0,
  children,
}: {
  at: Vec3;
  within: number;
  beyond?: number;
  children: ReactNode;
}) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    // `at` is in the parent's space: things inside moving groups measure
    // from where they are now.
    seen.set(...at);
    g.parent?.localToWorld(seen);
    const d = camera.position.distanceTo(seen);
    g.visible = d < within && d >= beyond;
  });
  return <group ref={group}>{children}</group>;
}

/** Selects on a click in place; a drag never selects. */
export const selectOnClick = (s: Selection) => ({
  onClick: (e: { stopPropagation: () => void; nativeEvent: MouseEvent }) => {
    if (isDrag(e)) return;
    e.stopPropagation();
    useStage.getState().select(s);
  },
});

const same = (a: Selection | null, b: Selection | undefined) =>
  b !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** A label lying on the top of a thing, near its front edge, read from the front. */
export function TopLabel({
  at,
  size,
  children,
  color = LOOK.text,
  weight = "bold",
  maxWidth,
}: {
  at: Vec3;
  size: number;
  children: string;
  color?: string;
  weight?: "regular" | "bold" | "mono";
  maxWidth?: number;
}) {
  return (
    <Label
      position={at}
      rotation={[-Math.PI / 2 + 0.55, 0, 0]}
      anchorY="bottom"
      fontSize={size}
      color={color}
      weight={weight}
      maxWidth={maxWidth}
      textAlign="center"
    >
      {children}
    </Label>
  );
}

/**
 * A thing that holds smaller things: a box with its name, its insides shown
 * only from near enough (`REVEAL` times its size).
 */
export function Container({
  spot,
  y = 0,
  name,
  color = LOOK.block,
  select,
  labelSize,
  children,
  note,
  labelFar = LABEL_FAR,
}: {
  spot: Spot;
  /** The label shows from within this many times the size. */
  labelFar?: number;
  y?: number;
  name: string;
  color?: string;
  select?: Selection;
  labelSize?: number;
  children?: ReactNode;
  /** A line under the name, shown from near. */
  note?: string;
}) {
  const selected = useStage((s) => same(s.selection, select));
  const size = Math.max(spot.w, spot.d);
  const center: Vec3 = [spot.x, y + spot.h, spot.z];
  const ls = labelSize ?? Math.min(size / 9, 9);
  return (
    <group>
      <mesh
        position={[spot.x, y + spot.h / 2, spot.z]}
        {...(select ? selectOnClick(select) : {})}
      >
        <boxGeometry args={[spot.w, spot.h, spot.d]} />
        <meshStandardMaterial
          color={selected ? LOOK.active : color}
          {...MATTE}
        />
      </mesh>
      <Near at={center} within={size * labelFar}>
        <TopLabel
          at={[spot.x, y + spot.h + 0.05, spot.z + spot.d / 2 + ls * 0.2]}
          size={ls}
          maxWidth={spot.w * 1.1}
        >
          {name}
        </TopLabel>
      </Near>
      {note && (
        <Near at={center} within={size * REVEAL}>
          <TopLabel
            at={[spot.x, y + spot.h + 0.05, spot.z + spot.d / 2 - ls * 2.6]}
            size={ls * 0.42}
            weight="regular"
            color={LOOK.textDim}
            maxWidth={spot.w * 0.9}
          >
            {note}
          </TopLabel>
        </Near>
      )}
      {children && (
        <Near at={center} within={size * REVEAL}>
          {children}
        </Near>
      )}
    </group>
  );
}

/** Lays `n` things out in a grid inside a spot, with a margin. */
export function grid(
  spot: Spot,
  n: number,
  { margin = 0.12, front = 0.22, aspect = 2.2 } = {},
) {
  const w = spot.w * (1 - margin * 2);
  const d = spot.d * (1 - margin - front);
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * w) / (d * aspect))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = w / cols;
  const rd = d / rows;
  return {
    cw,
    rd,
    at: (i: number) => ({
      x: spot.x - w / 2 + ((i % cols) + 0.5) * cw,
      z:
        spot.z -
        spot.d / 2 +
        spot.d * margin +
        (Math.floor(i / cols) + 0.5) * rd,
    }),
  };
}

/** The structure map's modules in a client district, each with its parts. */
function ClientModules({ spot, parts }: { spot: Spot; parts: ClientPart[] }) {
  const g = grid(spot, parts.length);
  const y = spot.h;
  return (
    <group>
      {parts.map((m, i) => {
        const { x, z } = g.at(i);
        const inner: Spot = {
          x,
          z,
          w: g.cw * 0.86,
          d: g.rd * 0.8,
          h: 1.6,
        };
        const kids = grid(inner, m.children.length, {
          margin: 0.1,
          front: 0.3,
        });
        return (
          <Container
            key={m.id}
            spot={inner}
            y={y}
            name={m.name}
            color={LOOK.blockSide}
            select={{ type: "part", id: m.id }}
            labelSize={Math.min(inner.w / 9, 1.6)}
            labelFar={5}
          >
            {m.children.map((c, k) => {
              const p = kids.at(k);
              return (
                <Container
                  key={c.id}
                  spot={{
                    x: p.x,
                    z: p.z,
                    w: kids.cw * 0.85,
                    d: kids.rd * 0.7,
                    h: 0.6,
                  }}
                  y={y + inner.h}
                  name={c.name}
                  color={LOOK.item}
                  select={{ type: "part", id: c.id }}
                  labelSize={Math.min((kids.cw * 0.85) / 10, 0.5)}
                  labelFar={6}
                />
              );
            })}
          </Container>
        );
      })}
    </group>
  );
}

/** The parts of the browser that stand still: present from the start. */
export function Floor({
  labels,
  exits,
  at,
  clientParts,
}: {
  labels: StageLabels;
  exits: Exit[];
  at: StageAt;
  clientParts: ClientPart[];
}) {
  const [x0, x1] = TERRITORY.x;
  const [z0, z1] = TERRITORY.z;
  const extra = exits.filter((e) => !(e.id in EXITS));
  return (
    <group>
      {/* The ground, far around. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[40_000, 40_000]} />
        <meshStandardMaterial color={LOOK.ground} {...MATTE} />
      </mesh>
      {/* The browser's territory: marked on the ground, not raised. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}
      >
        <planeGeometry args={[x1 - x0, z1 - z0]} />
        <meshStandardMaterial color={LOOK.platform} {...MATTE} />
      </mesh>
      <Near at={[0, 0, (z0 + z1) / 2]} within={6000}>
        <TopLabel at={[x0 + 26, 0.05, z1 - 4]} size={9} color={LOOK.textDim}>
          Browser
        </TopLabel>
      </Near>

      <Container
        spot={PAGE}
        name="Page"
        select={{ type: "thing", id: "page" }}
        note={at.path ? `at ${at.path}` : undefined}
      />

      {CLIENT.map((spot, i) => (
        <Container
          key={i}
          spot={spot}
          name={labels.client[i]}
          select={{ type: "thing", id: `client${i}` }}
          note={
            i === labels.clientMap
              ? `${clientParts.length} modules that run in the browser`
              : "not in the structure map"
          }
        >
          {i === labels.clientMap && (
            <ClientModules spot={spot} parts={clientParts} />
          )}
        </Container>
      ))}

      <Container
        spot={LOCAL}
        name="localStorage"
        color={LOOK.tray}
        select={{ type: "thing", id: "local" }}
        note={at.local.length === 0 ? "empty" : undefined}
      />
      <Container
        spot={COOKIES}
        name="Cookies"
        color={LOOK.tray}
        select={{ type: "thing", id: "cookies" }}
        note={at.cookies.length === 0 ? "none" : undefined}
      />

      {(["http", "socket"] as const).map((via) => {
        const c = CHANNELS[via];
        const len = c.to - c.from;
        return (
          <group key={via}>
            <mesh
              position={[c.x, 0.5, (c.from + c.to) / 2]}
              {...selectOnClick({ type: "thing", id: via })}
            >
              <boxGeometry args={[c.width, 1, len]} />
              <meshStandardMaterial color={LOOK.pipe} {...MATTE} />
            </mesh>
            <Near at={[c.x, 0, (c.from + c.to) / 2]} within={len * LABEL_FAR}>
              <TopLabel at={[c.x - c.width * 2.4, 0.05, c.to - 46]} size={6}>
                {via === "http" ? "HTTP" : "WebSocket"}
              </TopLabel>
            </Near>
            {via === "socket" && (
              <Near at={[c.x, 0, c.to - 56]} within={160}>
                <TopLabel
                  at={[c.x - c.width * 2.4, 0.05, c.to - 56]}
                  size={2.6}
                  weight="regular"
                  color={LOOK.textDim}
                >
                  {at.socketOpen ? "open" : "closed"}
                </TopLabel>
              </Near>
            )}
          </group>
        );
      })}

      {Object.entries(EXITS).map(([id, e]) => (
        <ExitGate
          key={id}
          x={e.x}
          w={e.w}
          exit={exits.find((x) => x.id === id)}
          busy={at.busyExits.has(id)}
        />
      ))}
      {extra.map((exit, i) => (
        <ExitGate
          key={exit.id}
          {...extraExit(i)}
          exit={exit}
          busy={at.busyExits.has(exit.id)}
        />
      ))}
    </group>
  );
}

/** An exit: a plain gate to something outside the browser, with no interior. */
function ExitGate({
  x,
  w,
  exit,
  busy,
}: {
  x: number;
  w: number;
  exit: Exit | undefined;
  busy: boolean;
}) {
  if (!exit) return null;
  const h = EXIT_HEIGHT;
  const post = 2.5;
  const select = selectOnClick({ type: "exit", id: exit.id });
  return (
    <group position={[x, 0, EXIT_Z]}>
      <mesh position={[0, (h - post) / 2, 0]} {...select}>
        <boxGeometry args={[w - post * 2, h - post, 0.5]} />
        <meshStandardMaterial
          color={busy ? LOOK.active : LOOK.exitOpening}
          {...MATTE}
        />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[(side * (w - post)) / 2, h / 2, 0]}
          {...select}
        >
          <boxGeometry args={[post, h, 4]} />
          <meshStandardMaterial color={LOOK.exit} {...MATTE} />
        </mesh>
      ))}
      <mesh position={[0, h - post / 2, 0]} {...select}>
        <boxGeometry args={[w, post, 4]} />
        <meshStandardMaterial color={LOOK.exit} {...MATTE} />
      </mesh>
      <Label
        position={[0, h + 1, 0]}
        anchorY="bottom"
        rotation={[-0.25, 0, 0]}
        fontSize={4.5}
        color={LOOK.text}
        weight="bold"
      >
        {exit.label}
      </Label>
    </group>
  );
}
