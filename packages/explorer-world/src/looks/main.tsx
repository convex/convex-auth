import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./looks.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureTextBuilder } from "troika-three-text";
import { Gallery } from "./Gallery.tsx";

// As in the world: the page itself requests the fonts of 3D text.
configureTextBuilder({ useWorker: false });

// The page's canvas text uses these fonts: load them before it is drawn.
void Promise.all(
  [
    "400 16px Inter",
    "500 16px Inter",
    "700 16px Inter",
    "400 16px 'JetBrains Mono'",
  ].map((f) => document.fonts.load(f)),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
