import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { usePlayback, world } from "../store.ts";
import { Alerts } from "./Alerts.tsx";
import { Backdrop } from "./Backdrop.tsx";
import { CameraRig } from "./CameraRig.tsx";
import { Islands } from "./Islands.tsx";
import { Labels } from "./Labels.tsx";
import { Links } from "./Links.tsx";
import { Parts } from "./Parts.tsx";
import { Rows } from "./Rows.tsx";
import { Holdings, Travellers } from "./Travellers.tsx";

/** Advances the playback time while playing. */
function Clock() {
  useFrame((_, delta) => {
    const s = usePlayback.getState();
    if (!s.playing) return;
    const next = s.time + Math.min(delta, 0.1) * s.speed;
    if (next >= world.timeline.duration) {
      s.setTime(world.timeline.duration);
      s.pause();
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
