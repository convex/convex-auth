import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import { isDrag } from "../scene/clicks.ts";
import { frames } from "../problems.ts";
import { Problems, SceneBoundary } from "../ui/Problems.tsx";
import { Activity } from "./Activity.tsx";
import { StageCamera } from "./Camera.tsx";
import { Floor } from "./Floor.tsx";
import { Paths } from "./Paths.tsx";
import { Inspector } from "./Inspector.tsx";
import { DEFAULT_VIEW, FOV } from "./layout.ts";
import { LIGHTS, LOOK } from "./look.ts";
import { stageAt, type StageAt } from "./model.ts";
import { Screen } from "./Screen.tsx";
import { modelOf, timeOf, useStage } from "./store.ts";
import { Timeline } from "./Timeline.tsx";
import { clientTree } from "./sources.ts";

const CLIENT_PARTS = clientTree();
import { ViewButtons } from "./ViewButtons.tsx";

const params = new URLSearchParams(location.search);

/** What changes the picture, without the movements' progress. */
function signature(at: StageAt): string {
  return [
    at.path,
    at.socketOpen,
    at.elements.length,
    ...at.local.map((s) => s.held.eventId),
    ...at.session.map((s) => s.held.eventId),
    ...at.cookies.map((s) => s.held.eventId),
    ...at.busyExits,
  ].join("|");
}

const moving = (at: StageAt) =>
  at.flights.length > 0 ||
  at.legs.length > 0 ||
  at.beats.length > 0 ||
  at.thens.length > 0 ||
  at.elements.some((e) => e.lit > 0) ||
  [...at.parts.values(), ...at.keys.values()].some((p) => p.lit > 0) ||
  [...at.local, ...at.session, ...at.cookies].some((s) => s.settled < 1);

/**
 * The scene at the time shown. The state is worked out each frame from the
 * time; the scene is drawn again when it changed or while something moves.
 */
function StageScene({ screen }: { screen: string | null }) {
  const source = useStage((s) => s.source);
  const live = useStage((s) => s.live);
  const labels = useStage((s) => s.labels);
  const model = modelOf({ source, live });
  const [at, setAt] = useState<StageAt>(() =>
    stageAt(model, timeOf(useStage.getState())),
  );
  const last = useRef({ sig: "", moving: false, model });
  useFrame(() => {
    frames.count++;
    const s = useStage.getState();
    const m = modelOf(s);
    const next = stageAt(m, timeOf(s));
    const sig = signature(next);
    const now = moving(next);
    const l = last.current;
    if (now || l.moving || sig !== l.sig || m !== l.model) {
      last.current = { sig, moving: now, model: m };
      setAt(next);
    }
  });
  return (
    <group>
      <Screen url={screen} live={source.kind === "live"} at={at} />
      <Floor
        labels={labels}
        exits={model.exits}
        at={at}
        clientParts={CLIENT_PARTS}
      />
      <Activity at={at} model={model} />
      <Paths
        at={at}
        ctx={{
          model,
          clientParts: CLIENT_PARTS,
          clientMap: labels.clientMap ?? 1,
        }}
      />
    </group>
  );
}

export function Stage({ screen }: { screen: string | null }) {
  return (
    <div className="stage">
      <Canvas
        className="stage-canvas"
        dpr={[1, 2]}
        gl={{
          alpha: true,
          antialias: true,
          preserveDrawingBuffer: params.has("capture"),
        }}
        camera={{
          fov: FOV,
          near: 0.3,
          far: 50_000,
          position: DEFAULT_VIEW.position,
        }}
        onPointerMissed={(e) => {
          if (!isDrag(e)) useStage.getState().select(null);
        }}
        fallback={
          <div className="problems panel no-webgl" role="alert">
            <p>This browser cannot draw WebGL, so the stage is not shown.</p>
          </div>
        }
      >
        <color attach="background" args={[LOOK.background]} />
        <ambientLight intensity={LIGHTS.ambient} />
        <directionalLight
          intensity={LIGHTS.sun.intensity}
          position={LIGHTS.sun.position}
        />
        <directionalLight
          intensity={LIGHTS.fill.intensity}
          position={LIGHTS.fill.position}
        />
        <SceneBoundary>
          <StageScene screen={screen} />
        </SceneBoundary>
        <StageCamera />
      </Canvas>
      <Problems />
      <ViewButtons />
      <Inspector />
      <Timeline />
    </div>
  );
}
