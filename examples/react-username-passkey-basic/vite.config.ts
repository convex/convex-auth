import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Passkey ceremonies are bound to this origin (see convex/auth.ts).
    // Fail instead of silently moving to another port.
    port: 5173,
    strictPort: true,
  },
});
