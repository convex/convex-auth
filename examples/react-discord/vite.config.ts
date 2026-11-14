import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The redirect origins in convex/auth.ts point at this port.
    // Fail instead of silently moving to another port.
    port: 5173,
    strictPort: true,
  },
});
