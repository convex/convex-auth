// The Vitest config from the testing docs, as an app writes it. The root
// config runs these tests too, but it loads the plugin from source; this one
// imports the published entry point, so it catches a broken export.
import { defineConfig } from "vitest/config";
import { convexAuthTest } from "@convex-dev/auth/test/vitest";

export default defineConfig({
  plugins: [convexAuthTest()],
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
  },
});
