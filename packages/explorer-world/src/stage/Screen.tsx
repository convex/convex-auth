import { Html } from "@react-three/drei";
import { memo } from "react";
import { DoubleSide } from "three";
import { Label } from "../scene/Label.tsx";
import { SCREEN_FRAME } from "./frame.ts";
import { GROUND_Y, SCREEN } from "./layout.ts";
import { LOOK, MATTE } from "./look.ts";
import type { StageAt } from "./model.ts";

const [cx, cy, cz] = SCREEN.center;
const W = SCREEN.width;
const H = SCREEN.height;
/** drei's Html maps one CSS pixel to distanceFactor / 400 units. */
const DISTANCE_FACTOR = (400 * W) / SCREEN.pxWidth;

// A fixed element to put the page in. drei's Html otherwise follows the
// element R3F listens on, which appears after the first render and would
// mount the page a second time.
const PORTAL = { current: document.getElementById("root") as HTMLElement };

let frameElement: HTMLIFrameElement | null = null;

/**
 * Loads the page on the screen again, at the path where the recording last
 * saw it: the frame is of another origin, so the stage cannot read its
 * address or call its `location.reload()`, but it may navigate it.
 */
export function reloadPage(path: string | null): void {
  if (!frameElement) return;
  const url = new URL(path ?? "/", new URL(frameElement.src).origin);
  frameElement.src = url.href;
}

/**
 * The app's page, live, in a frame on the screen. It is mounted once and
 * never again: a new mount would load the page anew. The canvas is drawn over
 * it with a hole where the screen is (`occlude="blending"`), so things in
 * front of the screen hide it as they should, and the pointer reaches the
 * page through the hole.
 */
const LivePage = memo(function LivePage({ url }: { url: string }) {
  return (
    <Html
      portal={PORTAL}
      transform
      occlude="blending"
      distanceFactor={DISTANCE_FACTOR}
      position={[cx, cy, cz + 0.01]}
      zIndexRange={[100, 0]}
    >
      <iframe
        ref={(el) => {
          frameElement = el;
        }}
        name={SCREEN_FRAME}
        title="The app's page"
        src={url}
        className="stage-frame"
        style={{ width: SCREEN.pxWidth, height: SCREEN.pxHeight }}
      />
    </Html>
  );
});

/** Where a rectangle of the page, in CSS pixels, is on the screen. */
function onScreen(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
) {
  const sx = W / viewport.width;
  const sy = H / viewport.height;
  return {
    x: cx - W / 2 + (rect.x + rect.width / 2) * sx,
    y: cy + H / 2 - (rect.y + rect.height / 2) * sy,
    w: rect.width * sx,
    h: rect.height * sy,
  };
}

/** An outline around an element that was just used. */
function Highlight({
  rect,
  viewport,
  lit,
}: {
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  lit: number;
}) {
  const r = onScreen(rect, viewport);
  const t = 0.06;
  const pad = 0.08;
  const w = r.w + pad * 2;
  const h = r.h + pad * 2;
  const bars: [number, number, number, number][] = [
    [r.x, r.y + h / 2, w + t, t],
    [r.x, r.y - h / 2, w + t, t],
    [r.x - w / 2, r.y, t, h],
    [r.x + w / 2, r.y, t, h],
  ];
  return (
    <group position={[0, 0, cz + 0.06]}>
      {bars.map(([x, y, bw, bh], i) => (
        <mesh key={i} position={[x, y, 0]} renderOrder={10}>
          <planeGeometry args={[bw, bh]} />
          <meshBasicMaterial
            color={LOOK.highlight}
            transparent
            opacity={lit}
            depthTest={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * The screen: a frame on a stand, standing on the ground at the back. Live,
 * it shows the app's page; in a replay, which has no page to show, it is dark
 * and says where the page was. Either way the element just used is outlined
 * where it was.
 */
export function Screen({
  url,
  live,
  at,
}: {
  url: string | null;
  live: boolean;
  at: StageAt;
}) {
  const b = SCREEN.bezel;
  const bottom = cy - H / 2 - b;
  const legH = bottom - GROUND_Y;
  return (
    <group>
      {/* The frame around the page. */}
      <mesh position={[cx, cy, cz - 0.3]}>
        <boxGeometry args={[W + b * 2, H + b * 2, 0.5]} />
        <meshStandardMaterial color={LOOK.bezel} {...MATTE} />
      </mesh>
      {/* The stand. */}
      {[-W / 3, W / 3].map((x) => (
        <mesh key={x} position={[cx + x, GROUND_Y + legH / 2, cz - 0.4]}>
          <boxGeometry args={[0.6, legH, 0.6]} />
          <meshStandardMaterial color={LOOK.stand} {...MATTE} />
        </mesh>
      ))}
      <mesh position={[cx, GROUND_Y + 0.15, cz - 0.4]}>
        <boxGeometry args={[W * 0.9, 0.3, 2.4]} />
        <meshStandardMaterial color={LOOK.stand} {...MATTE} />
      </mesh>
      {url !== null && <LivePage url={url} />}
      {(!live || url === null) && (
        <group>
          <mesh position={[cx, cy, cz + 0.03]} renderOrder={5}>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial color={LOOK.screenOff} side={DoubleSide} />
          </mesh>
          <Label
            position={[cx, cy + 0.6, cz + 0.08]}
            fontSize={0.7}
            color={LOOK.screenOffText}
          >
            {url === null ? "No live page" : "Replay"}
          </Label>
          <Label
            position={[cx, cy - 0.5, cz + 0.08]}
            fontSize={0.55}
            weight="mono"
            color={LOOK.screenOffText}
          >
            {at.path ?? ""}
          </Label>
        </group>
      )}
      {at.elements.map(({ element, lit, last }) =>
        lit > 0 && last?.rect && last.viewport ? (
          <Highlight
            key={element.key}
            rect={last.rect}
            viewport={last.viewport}
            lit={lit}
          />
        ) : null,
      )}
    </group>
  );
}
