import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const page = (name: string) =>
  fileURLToPath(new URL(`./${name}.html`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    // three.js and the scene are one large chunk; it is a local tool.
    chunkSizeWarningLimit: 2500,
    // The islands world and the stage; any other page of the package is
    // built when present.
    rollupOptions: {
      input: Object.fromEntries(
        ["index", "stage", "looks"]
          .filter((name) => existsSync(page(name)))
          .map((name) => [name, page(name)]),
      ),
    },
  },
});
