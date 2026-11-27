import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./stage.css";
import { createRoot } from "react-dom/client";
import { Vector3, type Camera } from "three";
import { configureTextBuilder } from "troika-three-text";
import {
  checkFonts,
  frames,
  reportProblem,
  watchFirstFrame,
} from "../problems.ts";
import { screenUrl } from "./frame.ts";
import { PANEL_CSS } from "./look.ts";
import { DEFAULT_VIEW, LOCAL, SCREEN } from "./layout.ts";
import { Stage } from "./Stage.tsx";
import { liveFeed, projectLabels, RECORDINGS, startLive } from "./sources.ts";
import { modelOf, timeOf, useStage } from "./store.ts";
import { stageAt } from "./model.ts";
import { stageFromEvents } from "../adapters/browserStage.ts";
import { parseNdjson } from "../adapters/convexRecording.ts";

configureTextBuilder({ useWorker: false });
for (const [name, value] of Object.entries(PANEL_CSS))
  document.documentElement.style.setProperty(name, value);

const params = new URLSearchParams(location.search);
useStage.setState((s) => ({ labels: { ...s.labels, ...projectLabels() } }));

let screen: string | null = null;
try {
  screen = screenUrl(params.get("screen"), location)?.href ?? null;
} catch (error) {
  reportProblem(error instanceof Error ? error.message : String(error));
}
try {
  startLive();
} catch (error) {
  reportProblem(error instanceof Error ? error.message : String(error));
}

// For scripted screenshots and checks: `?replay=<name>` opens a saved
// recording, `&at=<ms>` holds it that far in.
const replay = params.get("replay");
if (replay && RECORDINGS[replay]) {
  void RECORDINGS[replay]().then((text) => {
    const model = stageFromEvents(
      parseNdjson(text),
      useStage.getState().labels,
    );
    useStage.getState().replay(replay, model);
    if (params.has("at"))
      useStage.getState().hold(model.start + Number(params.get("at")));
  });
}

(window as unknown as { explorerStage: unknown }).explorerStage = {
  store: useStage,
  feed: liveFeed,
  frames,
  /** The state shown now, for checks. */
  now: () => {
    const s = useStage.getState();
    return stageAt(modelOf(s), timeOf(s));
  },
  model: () => modelOf(useStage.getState()),
  layout: { LOCAL, SCREEN, DEFAULT_VIEW },
  /** Where a point of the scene is on the window, in CSS pixels. */
  project: (x: number, y: number, z: number) => {
    const camera = (globalThis as { explorerCamera?: Camera }).explorerCamera;
    if (!camera) return null;
    const v = new Vector3(x, y, z).project(camera);
    return {
      x: ((v.x + 1) / 2) * innerWidth,
      y: ((1 - v.y) / 2) * innerHeight,
    };
  },
};

void checkFonts();
watchFirstFrame();

// No StrictMode: it mounts twice, and a second mount of the screen would load
// the app's page again, which the recorder would record.
createRoot(document.getElementById("root")!).render(<Stage screen={screen} />);
