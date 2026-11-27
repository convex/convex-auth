import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { frames } from "../problems.ts";
import { liveTrace, usePlayback, world } from "../store.ts";
import { Alerts } from "./Alerts.tsx";
import { Backdrop } from "./Backdrop.tsx";
import { CameraRig } from "./CameraRig.tsx";
import { Islands } from "./Islands.tsx";
import { Labels } from "./Labels.tsx";
import { Links } from "./Links.tsx";
import { Parts } from "./Parts.tsx";
import { Rows } from "./Rows.tsx";
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
    const next = s.time + Math.min(delta, 0.1) * s.speed;
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

export function World({ effects = true }: { effects?: boolean }) {
  return (
    <>
      <Clock />
      <Backdrop />
      <Islands />
      <Parts />
      <Rows />
      <Links />
      <Labels />
      <Travellers />
      <Holdings />
      <Alerts />
      <CameraRig />
      {effects && (
        <EffectComposer multisampling={4}>
          <Bloom
            mipmapBlur
            intensity={0.9}
            luminanceThreshold={0.55}
            luminanceSmoothing={0.3}
            radius={0.75}
          />
          <Vignette offset={0.25} darkness={0.75} />
        </EffectComposer>
      )}
    </>
  );
}
