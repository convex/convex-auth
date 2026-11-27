import { Canvas } from "@react-three/fiber";
import { ACESFilmicToneMapping } from "three";
import { isDrag } from "./scene/clicks.ts";
import { World } from "./scene/World.tsx";
import { usePlayback } from "./store.ts";
import { Controls } from "./ui/Controls.tsx";
import { CameraHud, Caption, Chapters, useShortcuts } from "./ui/Hud.tsx";
import { DiagPanel } from "./ui/DiagPanel.tsx";
import { Inspector } from "./ui/Inspector.tsx";
import { Problems, SceneBoundary } from "./ui/Problems.tsx";
import { Timeline } from "./ui/Timeline.tsx";

const params = new URLSearchParams(location.search);

export function App() {
  useShortcuts();
  // A live recording can add parts to the map; the scene mounts afresh then.
  const layoutVersion = usePlayback((s) => s.layoutVersion);
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
        onPointerMissed={(e) => {
          if (!isDrag(e)) usePlayback.getState().select(null);
        }}
        fallback={
          // Shown by the browser only where the canvas cannot be drawn.
          <div className="problems panel no-webgl" role="alert">
            <p>
              This browser cannot draw WebGL, so the 3D world is not shown. The
              panels still work.
            </p>
          </div>
        }
      >
        <SceneBoundary>
          <World key={layoutVersion} />
        </SceneBoundary>
      </Canvas>
      <Problems />
      <Chapters />
      <Caption />
      <CameraHud />
      <Inspector />
      <Timeline />
      <Controls />
      <DiagPanel />
    </div>
  );
}
