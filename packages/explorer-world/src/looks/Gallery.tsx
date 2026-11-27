/**
 * The gallery: the sample scene in one look at a time (tabs, or the keys 1
 * to 9), or every look side by side from the same camera (the contact
 * sheet, key 0). Play runs the sample motion; the handle scrubs it.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { PCFSoftShadowMap } from "three";
import { create } from "zustand";
import { GalleryCamera } from "./camera.tsx";
import { LookProvider } from "./kit.tsx";
import { START_VIEW } from "./layout.ts";
import type { Look } from "./look.ts";
import { LOOKS } from "./looks/index.ts";
import { DURATION, beatAt } from "./motion.ts";
import { SampleScene } from "./SampleScene.tsx";
import { scanScene } from "../diag.ts";

const params = new URLSearchParams(location.search);
/** Draw every frame, for scripted screenshots. */
const capture = params.has("capture");

type State = {
  /** The index of the look shown, or -1 for the contact sheet. */
  view: number;
  time: number;
  playing: boolean;
  show: (view: number) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
};

const initial = () => {
  if (params.has("sheet")) return -1;
  const i = LOOKS.findIndex((l) => l.id === params.get("look"));
  return Math.max(0, i);
};

export const useGallery = create<State>((set) => ({
  view: initial(),
  time: Math.min(DURATION, Math.max(0, Number(params.get("t") ?? 0) || 0)),
  playing: false,
  show: (view) => set({ view }),
  setTime: (time) => set({ time: Math.min(DURATION, Math.max(0, time)) }),
  setPlaying: (playing) => set({ playing }),
}));

/** Frames drawn, by every canvas, for scripted checks. */
const frames = { count: 0 };
Object.assign(globalThis, {
  looksFrames: frames,
  looksGallery: useGallery,
  looksIds: LOOKS.map((l) => l.id),
});

function GlSettings({ look }: { look: Look }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    gl.toneMapping = look.gl.toneMapping;
    gl.toneMappingExposure = look.gl.exposure;
    gl.shadowMap.enabled = look.gl.shadows;
    gl.shadowMap.type = PCFSoftShadowMap;
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [gl, look, invalidate]);
  return null;
}

/** Counts frames, draws one when the time moves, and exposes a scan. */
function Hooks({ main }: { main: boolean }) {
  const { gl, scene, camera, invalidate } = useThree();
  const time = useGallery((s) => s.time);
  useEffect(() => invalidate(), [time, invalidate]);
  useFrame(() => {
    frames.count++;
  });
  useEffect(() => {
    if (!main) return;
    Object.assign(globalThis, {
      looksDiag: { scan: () => scanScene(gl, scene, camera, "half") },
    });
  }, [main, gl, scene, camera]);
  return null;
}

function LookCanvas({ look, main }: { look: Look; main: boolean }) {
  const time = useGallery((s) => s.time);
  const { Stage, Effects } = look;
  return (
    <Canvas
      className="looks-canvas"
      frameloop={capture ? "always" : "demand"}
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ fov: 42, near: 0.5, far: 600, position: START_VIEW.position }}
    >
      <GlSettings look={look} />
      <LookProvider value={look}>
        {/* Mounted afresh for each look: nothing of the last one stays. */}
        <Fragment key={look.id}>
          <Stage />
          <SampleScene time={time} />
        </Fragment>
        {Effects && <Effects key={`effects-${look.id}`} />}
      </LookProvider>
      <GalleryCamera />
      <Hooks main={main} />
    </Canvas>
  );
}

function usePlayLoop() {
  const playing = useGallery((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const { time, setTime, setPlaying } = useGallery.getState();
      const t = time + (now - last) / 1000;
      last = now;
      setTime(t);
      if (t >= DURATION) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

function useKeys() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const g = useGallery.getState();
      const n = Number(e.key);
      if (e.key === "0") g.show(-1);
      else if (n >= 1 && n <= LOOKS.length) g.show(n - 1);
      else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
}

function togglePlay() {
  const g = useGallery.getState();
  if (g.playing) g.setPlaying(false);
  else {
    if (g.time >= DURATION) g.setTime(0);
    g.setPlaying(true);
  }
}

function Tabs() {
  const view = useGallery((s) => s.view);
  const show = useGallery((s) => s.show);
  return (
    <nav className="looks-tabs" aria-label="Looks">
      {LOOKS.map((l, i) => (
        <button
          key={l.id}
          aria-pressed={view === i}
          onClick={() => show(i)}
          title={l.summary}
        >
          <kbd>{i + 1}</kbd> {l.name}
        </button>
      ))}
      <button aria-pressed={view === -1} onClick={() => show(-1)}>
        <kbd>0</kbd> Contact sheet
      </button>
    </nav>
  );
}

function Transport() {
  const time = useGallery((s) => s.time);
  const playing = useGallery((s) => s.playing);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="looks-transport">
      <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "Pause" : "Play"}
      </button>
      <input
        ref={ref}
        type="range"
        min={0}
        max={DURATION}
        step={0.001}
        value={time}
        aria-label="Time"
        onChange={(e) => {
          useGallery.getState().setPlaying(false);
          useGallery.getState().setTime(Number(e.target.value));
        }}
      />
      <span className="looks-time">{time.toFixed(1)} s</span>
      <span className="looks-beat">{beatAt(time)}</span>
    </div>
  );
}

export function Gallery() {
  useKeys();
  usePlayLoop();
  const view = useGallery((s) => s.view);
  const look = view >= 0 ? LOOKS[view] : null;
  return (
    <div
      className={`looks ${look ? `chrome-${look.chrome}` : "chrome-dark sheet"}`}
    >
      {look ? (
        <div className="looks-single">
          <LookCanvas look={look} main />
          <p className="looks-summary">
            <strong>{look.name}.</strong> {look.summary}
          </p>
        </div>
      ) : (
        <div className="looks-sheet">
          {LOOKS.map((l, i) => (
            <figure key={l.id} className={`chrome-${l.chrome}`}>
              <LookCanvas look={l} main={i === 0} />
              <figcaption>
                <kbd>{i + 1}</kbd> {l.name}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <Tabs />
      <Transport />
    </div>
  );
}
