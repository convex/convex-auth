import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo } from "react";
import { config, usePlayback, world } from "../store.ts";
import { Backdrop } from "./Backdrop.tsx";
import { CameraRig } from "./CameraRig.tsx";
import { FunctionNode } from "./FunctionNode.tsx";
import { Island } from "./Island.tsx";
import { createLayout } from "./layout.ts";
import { AlertBanners, Clients, Links, Places } from "./Places.tsx";
import { TableVault } from "./TableVault.tsx";
import { Travellers } from "./Travellers.tsx";

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
  const layout = useMemo(() => createLayout(world.structure, config), []);
  return (
    <>
      <Clock />
      <Backdrop layout={layout} />
      <group>
        {world.structure.regions.map((r) => {
          const island = layout.islands.get(r.id);
          return island ? (
            <Island key={r.id} region={r} layout={island} />
          ) : null;
        })}
        {world.structure.functions.map((f) => {
          const l = layout.functions.get(f.id);
          return l ? <FunctionNode key={f.id} fn={f} layout={l} /> : null;
        })}
        {world.structure.tables.map((t) => {
          const l = layout.tables.get(t.id);
          return l ? <TableVault key={t.id} table={t} layout={l} /> : null;
        })}
        <Places layout={layout} />
        <Links layout={layout} />
        <Clients layout={layout} />
        <Travellers layout={layout} />
        <AlertBanners layout={layout} />
      </group>
      <CameraRig layout={layout} />
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
