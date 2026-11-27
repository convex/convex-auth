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
  LABEL_FIT,
  LABEL_READ,
  LOCAL,
  PAGE,
  REVEAL,
  TERRITORY,
  extraExit,
  type Spot,
  type Vec3,
} from "./layout.ts";
import { Ground } from "./Ground.tsx";
import { grid } from "./layout.ts";
import { moduleSpot } from "./places.ts";
export { grid };
import { LOOK, MATTE, mix } from "./look.ts";
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
  name,
}: {
  /** A name for checks to find what is shown. */
  name?: string;
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
  return (
    <group ref={group} name={name}>
      {children}
    </group>
  );
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

/**
 * A label lying on the top of a thing, near its front edge, read from the
 * front, at the size of the level the camera is at: drawn at reading size
 * (`LABEL_READ` of the distance to the camera), never larger than `size`,
 * and hidden while reading size would not fit (more than `LABEL_FIT` times
 * `size`). Thus a district's name is large from afar and modest from close
 * in, and a module's name shows once you are near enough to read it.
 */
export function TopLabel({
  at,
  size,
  children,
  color = LOOK.text,
  weight = "bold",
  maxWidth,
  anchorY = "bottom",
}: {
  at: Vec3;
  /** The largest the label is drawn. */
  size: number;
  children: string;
  color?: string;
  weight?: "regular" | "bold" | "mono";
  maxWidth?: number;
  anchorY?: "top" | "bottom";
}) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    seen.set(0, 0, 0);
    g.localToWorld(seen);
    const read = camera.position.distanceTo(seen) * LABEL_READ;
    g.visible = read <= size * LABEL_FIT;
    // Scaled about its anchor, which scaling does not move.
    const k = Math.min(1, read / size);
    if (Math.abs(g.scale.x - k) > 1e-3) g.scale.setScalar(k);
  });
  return (
    <group ref={group} position={at}>
      <Label
        rotation={[-Math.PI / 2 + 0.55, 0, 0]}
        anchorY={anchorY}
        fontSize={size}
        color={color}
        weight={weight}
        maxWidth={maxWidth === undefined ? undefined : maxWidth}
        textAlign="center"
      >
        {children}
      </Label>
    </group>
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
  const ls = labelSize ?? Math.min(size / 7, 16);
  return (
    <group name={`thing:${name}`}>
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
      <Near at={center} within={size * labelFar} name={`label:${name}`}>
        <TopLabel
          at={[spot.x, y + spot.h + 0.05, spot.z + spot.d / 2 + ls * 0.2]}
          size={ls}
          maxWidth={spot.w * 1.1}
        >
          {name}
        </TopLabel>
      </Near>
      {note && (
        <Near at={center} within={size * labelFar}>
          <TopLabel
            at={[spot.x, y + spot.h + 0.05, spot.z + spot.d / 2 + ls * 0.2]}
            size={ls * 0.42}
            weight="regular"
            color={LOOK.textDim}
            maxWidth={spot.w * 1.1}
            anchorY="top"
          >
            {note}
          </TopLabel>
        </Near>
      )}
      {children && (
        <Near at={center} within={size * REVEAL} name={`inside:${name}`}>
          {children}
        </Near>
      )}
    </group>
  );
}

/** The structure map's modules in a client district, each with its parts. */
function ClientModules({
  spot,
  parts,
  lit,
}: {
  spot: Spot;
  parts: ClientPart[];
  lit: StageAt["parts"];
}) {
  const y = spot.h;
  return (
    <group>
      {parts.map((m, i) => {
        const inner = moduleSpot(spot, i, parts.length);
        const kids = grid(inner, m.children.length, {
          margin: 0.1,
          front: 0.3,
        });
        return (
          <Container
            key={m.id}
            spot={inner}
            y={y}
            name={m.name.slice(m.name.lastIndexOf("/") + 1)}
            color={mix(LOOK.blockSide, LOOK.active, lit.get(m.id)?.lit ?? 0)}
            select={{ type: "part", id: m.id }}
            note={
              m.name.includes("/")
                ? m.name.slice(0, m.name.lastIndexOf("/"))
                : undefined
            }
            labelSize={Math.min(inner.w / 7, 4)}
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
                  labelSize={Math.min((kids.cw * 0.85) / 7, 1.2)}
                />
              );
            })}
          </Container>
        );
      })}
    </group>
  );
}

/**
 * How lit the auth client's district is, seen from afar: as much as the most
 * lit part of the client library. Every step the page reports is the
 * library's, so a step whose module is not among the district's (the map
 * places it elsewhere) lights the district too.
 */
function districtLit(at: StageAt): number {
  let most = 0;
  for (const p of at.parts.values()) most = Math.max(most, p.lit);
  return most;
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
      <Ground />
      {/* The browser's territory: marked on the ground, not raised. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}
      >
        <planeGeometry args={[x1 - x0, z1 - z0]} />
        <meshStandardMaterial color={LOOK.platform} {...MATTE} />
      </mesh>
      <Near at={[0, 0, (z0 + z1) / 2]} within={6000}>
        <TopLabel at={[x0 + 40, 0.05, z1 - 6]} size={16} color={LOOK.textDim}>
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
          color={
            i === labels.clientMap
              ? mix(LOOK.block, LOOK.active, districtLit(at) * 0.45)
              : LOOK.block
          }
          note={
            i === labels.clientMap
              ? `${clientParts.length} modules that run in the browser`
              : "not in the structure map"
          }
        >
          {i === labels.clientMap && (
            <ClientModules spot={spot} parts={clientParts} lit={at.parts} />
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
