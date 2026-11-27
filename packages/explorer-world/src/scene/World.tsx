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
import { Operations } from "./Operations.tsx";
import { Holdings, Travellers } from "./Travellers.tsx";

/** Advances the playback time while playing, and counts the frames drawn. */
function Clock() {
  useFrame(({ camera }, delta) => {
    frames.count++;
    // For scripted checks: where the camera is.
    (globalThis as { explorerCamera?: unknown }).explorerCamera = camera;
    const build = liveTrace.builds[liveTrace.builds.length - 1];
    if (build && build.drawnAt === null) build.drawnAt = Date.now();
    const s = usePlayback.getState();
    if (!s.playing) return;
    // Live, the world plays what was reported at a pace a person can watch;
    // a newer pressed control makes the one playing finish quickly.
    const rate = s.live ? hurry(world.timeline, s.time) : 1;
    // Slow frames still keep time (up to half a second at once).
    const next = s.time + Math.min(delta, 0.5) * s.speed * rate;
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
