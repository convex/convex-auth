import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./stage.css";
import { createRoot } from "react-dom/client";
import { Box3, Vector3, type Camera, type Object3D } from "three";
import { configureTextBuilder } from "troika-three-text";
import {
  checkFonts,
  frames,
  reportProblem,
  watchFirstFrame,
} from "../problems.ts";
import { screenUrl } from "./frame.ts";
import { PANEL_CSS } from "./look.ts";
import { DEFAULT_VIEW, HOME_FIT, LOCAL, SCREEN } from "./layout.ts";
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
  layout: { LOCAL, SCREEN, DEFAULT_VIEW, HOME_FIT },
  /** The names of the named groups drawn now (see `Near`). */
  shown: () => {
    const scene = (globalThis as { explorerScene?: Object3D }).explorerScene;
    const out: string[] = [];
    scene?.traverseVisible((o) => {
      if (o.name) out.push(o.name);
    });
    return out;
  },
  /** Where a named object is on the window, or null when not drawn. */
  locate: (name: string) => {
    const scene = (globalThis as { explorerScene?: Object3D }).explorerScene;
    const camera = (globalThis as { explorerCamera?: Camera }).explorerCamera;
    let found: Object3D | null = null;
    scene?.traverseVisible((o) => {
      if (!found && o.name === name) found = o;
    });
    if (!found || !camera) return null;
    const v = new Box3()
      .setFromObject(found)
      .getCenter(new Vector3())
      .project(camera);
    return {
      x: ((v.x + 1) / 2) * innerWidth,
      y: ((1 - v.y) / 2) * innerHeight,
    };
  },
  /**
   * What the next frame draws, sampled on a grid: the spread of its
   * luminance (0 for a uniform frame), and how many samples are the page
   * (where the canvas is clear).
   */
  sampleFrame: () =>
    new Promise<{ spread: number; page: number }>((done) => {
      const scene = (globalThis as { explorerScene?: Object3D }).explorerScene!;
      const prev = scene.onAfterRender;
      scene.onAfterRender = (renderer) => {
        scene.onAfterRender = prev;
        const gl = renderer.getContext();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const px = new Uint8Array(4);
        const lum: number[] = [];
        let page = 0;
        for (let i = 1; i < 24; i++)
          for (let j = 1; j < 24; j++) {
            gl.readPixels(
              (w * i) / 24,
              (h * j) / 24,
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              px,
            );
            if (px[3] < 8) page++;
            else lum.push(0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]);
          }
        const mean = lum.reduce((a, b) => a + b, 0) / Math.max(lum.length, 1);
        const spread = Math.sqrt(
          lum.reduce((a, b) => a + (b - mean) ** 2, 0) /
            Math.max(lum.length, 1),
        );
        done({ spread, page });
      };
    }),
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
