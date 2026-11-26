import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // three.js and the scene are one large chunk; it is a local tool.
    chunkSizeWarningLimit: 2500,
  },
});
