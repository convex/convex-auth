import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo } from "react";
import { useDiag } from "../diag.ts";
import { frames } from "../problems.ts";
import { hurry } from "../live.ts";
import { liveTrace, usePlayback, world } from "../store.ts";
import { Alerts } from "./Alerts.tsx";
import { Backdrop } from "./Backdrop.tsx";
import { Browser } from "./Browser.tsx";
import { CameraRig } from "./CameraRig.tsx";
import { Diagnostics, Layer } from "./Diagnostics.tsx";
import { Islands } from "./Islands.tsx";
import { Labels } from "./Labels.tsx";
import { Links } from "./Links.tsx";
import { Parts } from "./Parts.tsx";
import { Rows } from "./Rows.tsx";
import { SanitizePass } from "./safety.ts";
import { RunningHalos } from "./Running.tsx";
import { Operations } from "./Operations.tsx";
import { Holdings, Travellers } from "./Travellers.tsx";

/** The longest wall time one frame plays (s). */
const LONGEST_FRAME = 5;

/** Advances the playback time while playing, and counts the frames drawn. */
function Clock() {
  useFrame(({ camera, scene }, delta) => {
    frames.count++;
    // For scripted checks: where the camera is, and what is drawn.
    (globalThis as { explorerCamera?: unknown }).explorerCamera = camera;
    (globalThis as { explorerScene?: unknown }).explorerScene = scene;
    const build = liveTrace.builds[liveTrace.builds.length - 1];
    if (build && build.drawnAt === null) build.drawnAt = Date.now();
    const s = usePlayback.getState();
    if (!s.playing) return;
    // Shown time follows the wall clock: a slow machine draws fewer frames
    // and each one goes further. Only a gap longer than LONGEST_FRAME (a
    // hidden tab, a debugger) is not played through.
    let left = Math.min(delta, LONGEST_FRAME);
    let next = s.time;
    while (left > 0) {
      // Live, the world plays what was reported at a pace a person can
      // watch; a newer pressed control makes the one playing finish
      // quickly. The rate is taken again every tenth of a second.
      const dt = Math.min(left, 0.1);
      const rate = s.live ? hurry(world.timeline, next) : 1;
      next += dt * s.speed * rate;
      left -= dt;
      if (next >= world.timeline.duration) break;
    }
    if (next >= world.timeline.duration) {
      s.setTime(world.timeline.duration);
      // A live recording that still grows waits at its end for what comes.
      if (!s.live || s.live.connection === "ended") s.pause();
    } else {
      s.setTime(next);
    }
  });
  return null;
}

export function World() {
  return (
    <>
      <Clock />
      <Backdrop />
      <Layer name="islands">
        <Islands />
      </Layer>
      <Layer name="parts">
        <Parts />
        <Browser />
      </Layer>
      <Layer name="rows">
        <Rows />
      </Layer>
      <Layer name="links">
        <Links />
      </Layer>
      <Layer name="labels">
        <Labels />
      </Layer>
      <Layer name="travellers">
        <Travellers />
        <Operations />
        <RunningHalos />
        <Holdings />
        <Alerts />
      </Layer>
      <Diagnostics />
      <CameraRig />
      <Effects />
    </>
  );
}

/**
 * Bloom and vignette, after a pass that removes NaN, infinite and negative
 * values from the scene buffer: the bloom would spread one such pixel over a
 * black rectangle (see `safety.ts`). `?noeffects` turns both off, and the
 * diagnostics can turn each off.
 */
function Effects() {
  const { composer, bloom, vignette, sanitize } = useDiag();
  const pass = useMemo(() => new SanitizePass(), []);
  // With the composer on and every effect off, the frame still goes through
  // its half-float, multisampled buffers: a check of the composer alone.
  if (!composer) return null;
  return (
    <EffectComposer multisampling={4}>
      <>{sanitize && <primitive object={pass} />}</>
      <>
        {bloom && (
          <Bloom
            mipmapBlur
            intensity={0.9}
            luminanceThreshold={0.55}
            luminanceSmoothing={0.3}
            radius={0.75}
          />
        )}
      </>
      <>{vignette && <Vignette offset={0.25} darkness={0.75} />}</>
    </EffectComposer>
  );
}
