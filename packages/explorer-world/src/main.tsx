import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { usePlayback } from "./store.ts";
import { configureTextBuilder } from "troika-three-text";

// The page itself requests the fonts of 3D text. A request from troika's
// worker can be refused where the page's own is not, and then no text loads.
configureTextBuilder({ useWorker: false });

// Hooks for scripted screenshots: `?t=42&paused` opens the run at 42 s.
const params = new URLSearchParams(location.search);
if (params.has("t")) usePlayback.getState().setTime(Number(params.get("t")));
if (params.has("paused")) usePlayback.getState().pause();
// `?free` starts with the camera at the overview, not following the action.
if (params.has("free")) usePlayback.getState().setDirector(false);
// `?select=<part id>` opens with a part selected.
const selected = params.get("select");
if (selected) usePlayback.getState().select({ type: "part", id: selected });
(window as unknown as { explorer: typeof usePlayback }).explorer = usePlayback;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
