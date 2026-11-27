import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import { Vector3, type Group } from "three";
import { Label } from "../scene/Label.tsx";
import { isDrag } from "../scene/clicks.ts";
import type { StageLabels } from "../adapters/browserStage.ts";
import {
  CLIENT,
  COOKIES,
  EXIT_Z,
  EXITS,
  GROUND_Y,
  LOCAL,
  PAGE,
  PIPES,
  PLATFORM,
  extraExit,
  type Spot,
} from "./layout.ts";
import { LOOK, MATTE } from "./look.ts";
import type { Exit, StageAt } from "./model.ts";
import { useStage, type Selection } from "./store.ts";

/** A label standing just above the front edge of a thing, facing the viewer. */
function FrontLabel({
  at,
  children,
  size = 0.62,
  color = LOOK.text,
  weight = "bold",
}: {
  at: [number, number, number];
  children: string;
  size?: number;
  color?: string;
  weight?: "regular" | "bold" | "mono";
}) {
  return (
    <Label
      position={at}
      rotation={[-0.32, 0, 0]}
      anchorY="bottom"
      fontSize={size}
      color={color}
      weight={weight}
      maxWidth={9}
      textAlign="center"
    >
      {children}
    </Label>
  );
}

const seen = new Vector3();

/** Shows its children only when the camera is within `distance` of `at`. */
export function Near({
  at,
  distance,
  children,
}: {
  at: [number, number, number];
  distance: number;
  children: ReactNode;
}) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    seen.set(...at);
    g.visible = camera.position.distanceTo(seen) < distance;
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

function Block({
  spot,
  color = LOOK.block,
  select,
  children,
}: {
  spot: Spot;
  color?: string;
  select?: Selection;
  children?: ReactNode;
}) {
  const selected = useStage(
    (s) =>
      select !== undefined &&
      JSON.stringify(s.selection) === JSON.stringify(select),
  );
  return (
    <group position={[spot.x, 0, spot.z]}>
      <mesh
        position={[0, spot.h / 2, 0]}
        {...(select ? selectOnClick(select) : {})}
      >
        <boxGeometry args={[spot.w, spot.h, spot.d]} />
        <meshStandardMaterial
          color={selected ? LOOK.active : color}
          {...MATTE}
        />
      </mesh>
      {children}
    </group>
  );
}

/** The parts of the browser that stand still: present from the start. */
export function Floor({
  labels,
  exits,
  at,
}: {
  labels: StageLabels;
  exits: Exit[];
  at: StageAt;
}) {
  const [x0, x1] = PLATFORM.x;
  const [z0, z1] = PLATFORM.z;
  const extra = exits.filter((e) => !(e.id in EXITS));
  return (
    <group>
      {/* The ground, far around. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_Y, 10]}>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color={LOOK.ground} {...MATTE} />
      </mesh>
      {/* The floor of the browser. */}
      <mesh position={[(x0 + x1) / 2, GROUND_Y / 2, (z0 + z1) / 2]}>
        <boxGeometry args={[x1 - x0, -GROUND_Y, z1 - z0]} />
        <meshStandardMaterial color={LOOK.platform} {...MATTE} />
      </mesh>
      <FrontLabel
        at={[x1 - 1.8, 0.1, z1 - 0.2]}
        size={0.5}
        color={LOOK.textDim}
        weight="regular"
      >
        Browser
      </FrontLabel>

      {/* The page: the elements the person used stand on it. */}
      <Block spot={PAGE} select={{ type: "thing", id: "page" }}>
        <FrontLabel at={[-PAGE.w / 2 + 1.4, PAGE.h + 0.1, PAGE.d / 2]}>
          Page
        </FrontLabel>
        <FrontLabel
          at={[PAGE.w / 2 - 2.6, PAGE.h + 0.1, PAGE.d / 2]}
          size={0.42}
          weight="mono"
          color={LOOK.textDim}
        >
          {at.path ?? ""}
        </FrontLabel>
      </Block>

      {/* The client code. Nothing in the recording says which part ran, so
          nothing here moves. */}
      {CLIENT.map((spot, i) => (
        <Block key={i} spot={spot} select={{ type: "thing", id: `client${i}` }}>
          <FrontLabel at={[0, spot.h + 0.1, spot.d / 2]} size={0.52}>
            {labels.client[i]}
          </FrontLabel>
        </Block>
      ))}

      {/* Storage. */}
      <Block
        spot={LOCAL}
        color={LOOK.tray}
        select={{ type: "thing", id: "local" }}
      >
        <FrontLabel at={[-LOCAL.w / 2 + 2, LOCAL.h + 0.1, LOCAL.d / 2]}>
          localStorage
        </FrontLabel>
        {at.local.length === 0 && (
          <Near at={[LOCAL.x, 0, LOCAL.z]} distance={26}>
            <FrontLabel
              at={[1.6, LOCAL.h + 0.05, 0]}
              size={0.4}
              weight="regular"
              color={LOOK.textDim}
            >
              empty
            </FrontLabel>
          </Near>
        )}
      </Block>
      <Block
        spot={COOKIES}
        color={LOOK.tray}
        select={{ type: "thing", id: "cookies" }}
      >
        <FrontLabel at={[-COOKIES.w / 2 + 1.4, COOKIES.h + 0.1, COOKIES.d / 2]}>
          Cookies
        </FrontLabel>
        {at.cookies.length === 0 && (
          <Near at={[COOKIES.x, 0, COOKIES.z]} distance={26}>
            <FrontLabel
              at={[1.6, COOKIES.h + 0.05, 0]}
              size={0.4}
              weight="regular"
              color={LOOK.textDim}
            >
              none
            </FrontLabel>
          </Near>
        )}
      </Block>

      {/* The connections out. */}
      {(["http", "socket"] as const).map((via) => {
        const p = PIPES[via];
        const len = p.to - p.from;
        const open = via === "http" || at.socketOpen;
        return (
          <group key={via}>
            <mesh
              position={[p.x, 0.12, (p.from + p.to) / 2]}
              {...selectOnClick({ type: "thing", id: via })}
            >
              <boxGeometry args={[1.3, 0.24, len]} />
              <meshStandardMaterial color={LOOK.pipe} {...MATTE} />
            </mesh>
            <FrontLabel
              at={[p.x + (via === "http" ? -1.5 : 2.1), 0.1, p.to - 2.2]}
              size={0.5}
            >
              {via === "http" ? "HTTP" : "WebSocket"}
            </FrontLabel>
            {via === "socket" && (
              <Near at={[p.x, 0, p.to]} distance={22}>
                <FrontLabel
                  at={[p.x + 2.1, 0.1, p.to - 3.2]}
                  size={0.34}
                  weight="regular"
                  color={LOOK.textDim}
                >
                  {open ? "open" : "closed"}
                </FrontLabel>
              </Near>
            )}
          </group>
        );
      })}

      {/* The exits: what is outside the browser, with no interior. */}
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
  const h = 2.2;
  const post = 0.4;
  const select = selectOnClick({ type: "exit", id: exit.id });
  return (
    <group position={[x, GROUND_Y, EXIT_Z]}>
      <mesh position={[0, h / 2, -0.05]} {...select}>
        <boxGeometry args={[w - post * 2, h - post, 0.1]} />
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
          <boxGeometry args={[post, h, 0.8]} />
          <meshStandardMaterial color={LOOK.exit} {...MATTE} />
        </mesh>
      ))}
      <mesh position={[0, h - post / 2, 0]} {...select}>
        <boxGeometry args={[w, post, 0.8]} />
        <meshStandardMaterial color={LOOK.exit} {...MATTE} />
      </mesh>
      <Label
        position={[0, h + 0.15, 0]}
        anchorY="bottom"
        rotation={[-0.32, 0, 0]}
        fontSize={0.55}
        color={LOOK.text}
        weight="bold"
      >
        {exit.label}
      </Label>
    </group>
  );
}
