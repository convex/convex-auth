import { Canvas } from "@react-three/fiber";
import { ACESFilmicToneMapping } from "three";
import { World } from "./scene/World.tsx";
import { usePlayback } from "./store.ts";
import { CameraHud, Caption, Chapters, useShortcuts } from "./ui/Hud.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { Timeline } from "./ui/Timeline.tsx";

const params = new URLSearchParams(location.search);

export function App() {
  useShortcuts();
  return (
    <div className="app">
      <Canvas
        className="canvas"
        dpr={[1, 2]}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          toneMapping: ACESFilmicToneMapping,
          preserveDrawingBuffer: params.has("capture"),
        }}
        camera={{ fov: 42, near: 0.5, far: 4000, position: [0, 200, 260] }}
        onPointerMissed={() => usePlayback.getState().select(null)}
      >
        <World effects={!params.has("noeffects")} />
      </Canvas>
      <Chapters />
      <Caption />
      <CameraHud />
      <Inspector />
      <Timeline />
    </div>
  );
}
