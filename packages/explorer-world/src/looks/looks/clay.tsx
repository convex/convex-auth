/**
 * Warm clay: the vast sample in soft, rounded, low-poly forms shaded by
 * matcaps (no lights), with soft shadows painted under each thing as if
 * baked, on a warm ground that fades into the haze of a far horizon. Things
 * that are active rise a little and blush. Names are painted on the ground
 * or set into the faces of things.
 *
 * No post effects: nothing reads a half-float buffer, so there is nothing
 * for a GPU to blow up (see `../../scene/safety.ts`).
 */
import { Line, RoundedBox } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, type ReactNode } from "react";
import {
  BackSide,
  BufferAttribute,
  CanvasTexture,
  Color,
  SphereGeometry,
  NoToneMapping,
  SRGBColorSpace,
  Vector3,
  type Group,
  type Mesh,
  type PerspectiveCamera,
  type Texture,
} from "three";
import { Words, usePage } from "../kit.tsx";
import type {
  CarrierProps,
  GateProps,
  MonumentProps,
  NameProps,
  PageStyle,
  PieceProps,
  PlaceProps,
  TrailProps,
  WorldLook,
} from "../look.ts";

// The palette.
const SKY_TOP = "#fbe7d1";
const HORIZON = "#f4cfaa";
const GROUND = "#eebc8c";
const GROUND_POOL = "#f6cfa4";
const FIELD = "#fbe2c6";
const INK = "#4e3326";
const INK_SOFT = "#8a6450";
const SHADOW = "#9c5a3c";
const ACTIVE = "#ff7a5c";
const REQUEST = "#ff6f5e";
const RESPONSE = "#f2ac2c";

/** The colour of each big thing, by its id. */
const DISTRICT: Record<string, string> = {
  browser: "#fbe5cc",
  page: "#ffd27c",
  appCode: "#9ccdf5",
  authClient: "#ffa587",
  convexClient: "#f5b8d0",
  localStorage: "#a6dcb4",
  cookies: "#d4bdf2",
  websocket: "#a9b8ff",
  http: "#a9b8ff",
};
const districtColour = (id: string) =>
  DISTRICT[id.split(":")[0]] ?? DISTRICT.browser;

const mix = (a: string, b: string, t: number) =>
  `#${new Color(a).lerp(new Color(b), t).getHexString()}`;

// Matcaps: a lit clay sphere per colour, painted once.
const matcaps = new Map<string, Texture>();
function matcap(colour: string): Texture {
  let t = matcaps.get(colour);
  if (t) return t;
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  // The shade side warms toward the ground's colour, as bounced light.
  const shade = mix(mix(colour, SHADOW, 0.45), GROUND, 0.25);
  const base = g.createRadialGradient(
    S * 0.36,
    S * 0.3,
    S * 0.02,
    S * 0.5,
    S * 0.5,
    S * 0.62,
  );
  base.addColorStop(0, mix(colour, "#ffffff", 0.55));
  base.addColorStop(0.35, mix(colour, "#ffffff", 0.12));
  base.addColorStop(0.75, colour);
  base.addColorStop(1, shade);
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  // A soft rim from the ground below.
  const rim = g.createRadialGradient(
    S * 0.55,
    S * 0.75,
    S * 0.3,
    S * 0.5,
    S * 0.5,
    S * 0.52,
  );
  rim.addColorStop(0, "rgba(255,230,200,0)");
  rim.addColorStop(1, "rgba(255,226,190,0.35)");
  g.fillStyle = rim;
  g.fillRect(0, 0, S, S);
  t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  matcaps.set(colour, t);
  return t;
}

const Clay = ({
  colour,
  opacity = 1,
}: {
  colour: string;
  opacity?: number;
}) => (
  <meshMatcapMaterial
    matcap={matcap(colour)}
    transparent={opacity < 1}
    opacity={opacity}
  />
);

// The soft shadow under a thing: a blurred rounded rectangle, painted once.
let blobTexture: Texture | null = null;
function blob(): Texture {
  if (blobTexture) return blobTexture;
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  // The shape is drawn off the canvas; only its blurred shadow lands on it.
  g.shadowColor = "#fff";
  g.shadowBlur = 34;
  g.shadowOffsetX = S * 4;
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(-S * 4 + 52, 52, S - 104, S - 104, 28);
  g.fill();
  blobTexture = new CanvasTexture(canvas);
  return blobTexture;
}

/** A shadow on the surface under a footprint, cast a little toward the viewer. */
function Shadow({
  w,
  d,
  strength = 0.32,
  spread = 1.3,
}: {
  w: number;
  d: number;
  strength?: number;
  spread?: number;
}) {
  const grow =
    Math.min(w, d) * (spread - 1) + Math.min(2, Math.min(w, d) * 0.15);
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[w * 0.03, 0.04, d * 0.05 + Math.min(0.6, d * 0.05)]}
      renderOrder={1}
    >
      <planeGeometry args={[(w + grow) * 1.15, (d + grow) * 1.15]} />
      <meshBasicMaterial
        color={SHADOW}
        alphaMap={blob()}
        transparent
        opacity={strength}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

/** The letter height that fits `text` in `width`. */
const fit = (text: string, size: number, width: number, k = 0.6) =>
  Math.min(size, width / Math.max(1, text.length * k));

/** Scales its children up so that they stay `px` pixels tall at any distance. */
function KeepReadable({
  size,
  px,
  children,
}: {
  size: number;
  px: number;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  const height = useThree((s) => s.size.height);
  const at = useMemo(() => new Vector3(), []);
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g) return;
    g.getWorldPosition(at);
    const d = at.distanceTo(camera.position);
    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180;
    const perMetre = height / (2 * Math.tan(fov / 2) * Math.max(d, 1e-3));
    const shown = size * perMetre;
    g.scale.setScalar(shown < px ? px / shown : 1);
  });
  return <group ref={ref}>{children}</group>;
}

/** Shows its children only while text of `size` reads at `px` pixels or more. */
function Legible({
  size,
  px = 6,
  children,
}: {
  size: number;
  px?: number;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  const height = useThree((s) => s.size.height);
  const at = useMemo(() => new Vector3(), []);
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g) return;
    g.getWorldPosition(at);
    const d = at.distanceTo(camera.position);
    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180;
    const perMetre = height / (2 * Math.tan(fov / 2) * Math.max(d, 1e-3));
    g.visible = size * perMetre >= px;
  });
  return <group ref={ref}>{children}</group>;
}

/** The sky: a dome around the camera, the haze of the horizon fading up. */
function Sky() {
  const ref = useRef<Mesh>(null);
  const geometry = useMemo(() => {
    const g = new SphereGeometry(6000, 32, 24);
    const top = new Color(SKY_TOP);
    const low = new Color(HORIZON);
    const p = g.attributes.position;
    const colours = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const up = Math.min(1, Math.max(0, p.getY(i) / 6000 / 0.45));
      const c = low.clone().lerp(top, Math.sqrt(up));
      c.toArray(colours, i * 3);
    }
    g.setAttribute("color", new BufferAttribute(colours, 3));
    return g;
  }, []);
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} geometry={geometry} renderOrder={-3}>
      <meshBasicMaterial
        vertexColors
        side={BackSide}
        fog={false}
        depthWrite={false}
      />
    </mesh>
  );
}

const page: PageStyle = {
  background: "#fff8ef",
  text: INK,
  muted: INK_SOFT,
  field: "#ffffff",
  fieldBorder: "#e6c7aa",
  button: "#ff8a6b",
  buttonText: "#ffffff",
  buttonPressed: "#e85f43",
  link: "#e0663f",
  font: "Inter",
  stroke: 4,
};

function Ground() {
  const pool = useMemo(() => {
    const S = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const g = canvas.getContext("2d")!;
    const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    r.addColorStop(0, "#fff");
    r.addColorStop(0.5, "rgba(255,255,255,0.55)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = "#000";
    g.fillRect(0, 0, S, S);
    g.fillStyle = r;
    g.fillRect(0, 0, S, S);
    return new CanvasTexture(canvas);
  }, []);
  return (
    <>
      {/* Drawn first, writing no depth: whatever stands on it is in front. */}
      <mesh rotation-x={-Math.PI / 2} renderOrder={-2}>
        <circleGeometry args={[9000, 64]} />
        <meshBasicMaterial color={GROUND} depthWrite={false} />
      </mesh>
      {/* A warm pool of light under the browser. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, -150]} renderOrder={-1}>
        <planeGeometry args={[2400, 1700]} />
        <meshBasicMaterial
          color={GROUND_POOL}
          alphaMap={pool}
          transparent
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

function Monument({
  position,
  width,
  height,
  pageLift,
  pressed,
}: MonumentProps) {
  const map = usePage(page, pressed);
  const bezel = 14;
  const depth = 18;
  const bodyH = pageLift + height + bezel;
  return (
    <group position={position}>
      <Shadow w={width + bezel * 2} d={depth} strength={0.45} spread={6} />
      <RoundedBox
        args={[width + bezel * 2, bodyH, depth]}
        radius={4}
        smoothness={3}
        position={[0, bodyH / 2, 0]}
      >
        <Clay colour="#d98a6a" />
      </RoundedBox>
      <mesh position={[0, pageLift + height / 2, depth / 2 + 0.4]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={map} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * The browser's land: a field a shade lighter than the ground, its edge
 * soft, so that it reads as a place on the ground and not as a slab.
 */
function Land({ w, h, d }: { w: number; h: number; d: number }) {
  const texture = useMemo(() => {
    const S = 512;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, S, S);
    g.shadowColor = "#fff";
    g.shadowBlur = 40;
    g.shadowOffsetX = S * 4;
    g.fillStyle = "#fff";
    g.beginPath();
    g.roundRect(-S * 4 + 44, 44, S - 88, S - 88, 90);
    g.fill();
    return new CanvasTexture(canvas);
  }, []);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, h, 0]} renderOrder={-1}>
      <planeGeometry args={[w * 1.12, d * 1.16]} />
      <meshBasicMaterial
        color={FIELD}
        alphaMap={texture}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

function Place({
  kind,
  id,
  position,
  size,
  active,
  children,
}: PlaceProps & { children?: ReactNode }) {
  const [w, h, d] = size;
  const territory = kind === "territory";
  const colour = active
    ? mix(districtColour(id), "#ffffff", 0.3)
    : districtColour(id);
  return (
    <group position={position}>
      {!territory && <Shadow w={w} d={d} strength={0.12} spread={1.04} />}
      {territory ? (
        <Land w={w} h={h} d={d} />
      ) : (
        <RoundedBox
          args={[w, h, d]}
          radius={Math.min(h * 0.45, 1.2)}
          smoothness={2}
          position={[0, h / 2, 0]}
        >
          <Clay colour={colour} />
        </RoundedBox>
      )}
      {children}
    </group>
  );
}

/** A source file: a tab at its back corner, as on a folder. */
function ModuleCraft({
  w,
  h,
  d,
  colour,
}: {
  w: number;
  h: number;
  d: number;
  colour: string;
}) {
  return (
    <>
      <RoundedBox
        args={[w * 0.34, 1.4, 4]}
        radius={0.6}
        smoothness={2}
        position={[-w / 2 + w * 0.17 + 0.6, h + 0.4, -d / 2 + 2.4]}
      >
        <Clay colour={colour} />
      </RoundedBox>
    </>
  );
}

/** A file's name on its front: the folder small, the file large. */
function FileName({
  label,
  w,
  h,
  d,
}: {
  label: string;
  w: number;
  h: number;
  d: number;
}) {
  const cut = label.lastIndexOf("/");
  const dir = cut >= 0 ? label.slice(0, cut + 1) : "";
  const file = label.slice(cut + 1);
  const big = fit(file, Math.min(3, h * 0.28), w * 0.86);
  return (
    <group position={[0, h * 0.5, d / 2 + 0.06]}>
      {dir && (
        <Words
          position={[0, big * 0.95, 0]}
          fontSize={fit(dir, big * 0.55, w * 0.86)}
          color={INK_SOFT}
        >
          {dir}
        </Words>
      )}
      <Words position={[0, 0, 0]} fontSize={big} color={INK} weight="bold">
        {file}
      </Words>
    </group>
  );
}

function Piece({ kind, id, label, note, size, active }: PieceProps) {
  const [w, h, d] = size;
  const home = districtColour(id);
  const lift = active ? Math.max(0.4, h * 0.6) : 0;
  const colour = active
    ? ACTIVE
    : kind === "module"
      ? mix(home, "#ffffff", 0.35)
      : kind === "value"
        ? "#ffd889"
        : kind === "key"
          ? mix(home, "#ffffff", 0.45)
          : "#fff4e6";
  const radius =
    kind === "module"
      ? Math.min(1.8, w * 0.08, h * 0.3)
      : kind === "function"
        ? h * 0.48
        : Math.min(h * 0.45, w * 0.2, d * 0.2);
  const mono = kind !== "module" && kind !== "function";
  const ink = active ? "#ffffff" : INK;
  // A big thing names itself on its face, its top being taken by what it holds.
  const onFace =
    kind === "module" || kind === "key" || (kind === "element" && d > 20);
  return (
    <group position={[0, lift, 0]}>
      <Shadow w={w} d={d} strength={0.24} spread={1.08} />
      <RoundedBox
        args={[w, h, d]}
        radius={radius}
        smoothness={2}
        position={[0, h / 2, 0]}
      >
        <Clay colour={colour} />
      </RoundedBox>
      {kind === "module" && <ModuleCraft w={w} h={h} d={d} colour={colour} />}
      <Legible
        size={
          kind === "module" ? Math.min(3, h * 0.28) : Math.min(d * 0.3, 1.6)
        }
      >
        {kind === "module" ? (
          <FileName label={label} w={w} h={h} d={d} />
        ) : onFace ? (
          <Words
            position={[0, h * 0.5, d / 2 + 0.06]}
            fontSize={fit(label, 1.6, w * 0.88)}
            color={INK}
            weight={mono ? "mono" : "bold"}
          >
            {label}
          </Words>
        ) : kind === "claim" ? (
          <group position={[0, h + 0.04, 0]} rotation-x={-Math.PI / 2}>
            <Words
              position={[-w / 2 + 1.2, 0, 0]}
              anchorX="left"
              fontSize={Math.min(1.5, d * 0.5)}
              color={ink}
              weight="bold"
            >
              {label}
            </Words>
            <Words
              position={[-w / 2 + 6, 0, 0]}
              anchorX="left"
              fontSize={fit(note ?? "", Math.min(1.3, d * 0.42), w - 7.5)}
              color={ink}
              weight="mono"
            >
              {note ?? ""}
            </Words>
          </group>
        ) : (
          <group position={[0, h + 0.04, 0]} rotation-x={-Math.PI / 2}>
            <Words
              position={[0, note ? d * 0.14 : 0, 0]}
              fontSize={fit(label, Math.min(d * 0.32, 2.2), w * 0.9)}
              color={ink}
              weight={mono ? "mono" : "bold"}
            >
              {label}
            </Words>
            {note && (
              <Words
                position={[0, -d * 0.22, 0]}
                fontSize={fit(note, Math.min(d * 0.2, 1.6), w * 0.9)}
                color={active ? "#ffffff" : INK_SOFT}
              >
                {note}
              </Words>
            )}
          </group>
        )}
      </Legible>
    </group>
  );
}

function Gate({ position, width, height, label, active }: GateProps) {
  const post = width * 0.16;
  const colour = active ? mix(ACTIVE, "#ffffff", 0.25) : "#fff0de";
  return (
    <group position={position}>
      <group rotation-y={Math.PI / 2}>
        <Shadow w={post * 1.4} d={width} strength={0.35} spread={1.4} />
        {/* The opening faces along the channel, forward. */}
        {[-1, 1].map((s) => (
          <RoundedBox
            key={s}
            args={[post, height, post]}
            radius={post * 0.3}
            smoothness={2}
            position={[0, height / 2, s * (width / 2 - post / 2)]}
          >
            <Clay colour={colour} />
          </RoundedBox>
        ))}
        <RoundedBox
          args={[post * 1.3, post * 1.1, width + post * 0.4]}
          radius={post * 0.3}
          smoothness={2}
          position={[0, height + post * 0.4, 0]}
        >
          <Clay colour={colour} />
        </RoundedBox>
      </group>
      <group position={[0, height + post * 2.2, 0]}>
        <Legible size={3.2} px={9}>
          <Words
            fontSize={fit(label, 3.2, width * 1.5)}
            color={INK}
            weight="bold"
          >
            {label}
          </Words>
        </Legible>
      </group>
    </group>
  );
}

function Trail({ points, kind }: TrailProps) {
  return (
    <Line
      points={points}
      color={kind === "request" ? REQUEST : RESPONSE}
      lineWidth={3}
      transparent
      opacity={0.85}
    />
  );
}

/** A request, a response or a token: always big enough to follow. */
function Carrier({ position, kind, opacity }: CarrierProps) {
  const ref = useRef<Mesh>(null);
  const base = kind === "token" ? 1.1 : 1.6;
  useFrame(({ camera }) => {
    const m = ref.current;
    if (!m) return;
    const d = m.position.distanceTo(camera.position);
    m.scale.setScalar(Math.max(base, d * 0.011));
  });
  const colour = kind === "request" ? REQUEST : RESPONSE;
  return (
    <mesh ref={ref} position={position}>
      {kind === "token" ? (
        <boxGeometry args={[1.6, 0.8, 0.8]} />
      ) : (
        <icosahedronGeometry args={[1, 1]} />
      )}
      <Clay colour={colour} opacity={opacity} />
    </mesh>
  );
}

function Name({ position, text, size, kind, flat }: NameProps) {
  const words = (
    <Words
      fontSize={size}
      color={kind === "place" ? INK : INK_SOFT}
      weight={kind === "place" ? "bold" : "regular"}
      letterSpacing={kind === "place" ? 0.02 : 0}
      anchorY={flat ? "middle" : "bottom"}
    >
      {text}
    </Words>
  );
  // A standing name leans back, to read from above as well as from the front.
  return (
    <group position={position} rotation-x={flat ? -Math.PI / 2 : -0.45}>
      {kind === "place" ? (
        <KeepReadable size={size} px={15}>
          {words}
        </KeepReadable>
      ) : (
        words
      )}
    </group>
  );
}

export const clay: WorldLook = {
  id: "clay",
  name: "Warm clay (vast)",
  summary:
    "The vast sample: soft matcap clay, painted-on shadows, rounded low-poly forms on a warm ground that fades into a far horizon. F, B, A, J jump between the levels.",
  chrome: "light",
  gl: { toneMapping: NoToneMapping, exposure: 1, shadows: false },
  page,
  Stage: () => (
    <>
      <Sky />
      <fog attach="fog" args={[HORIZON, 2200, 7500]} />
    </>
  ),
  Effects: null,
  world: { Ground, Monument, Place, Piece, Gate, Trail, Carrier, Name },
};
