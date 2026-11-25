import { defineConfig } from "@playwright/test";

// `npx convex dev` writes the deployment to .env.local. The tests that call
// the deployment's admin functions read it from there.
try {
  process.loadEnvFile(".env.local");
} catch {
  // Not set up yet: the backend server below sets it up.
}

const port = 4173;

export default defineConfig({
  webServer: [
    {
      // Pushes the functions of convex/ to the deployment of .env.local, and
      // keeps it running while the tests do (a local deployment stops with
      // the command).
      command: "npx convex dev --typecheck disable --tail-logs disable",
      wait: { stderr: /Convex functions ready/ },
      timeout: 180_000,
    },
    {
      // A production build, as the app ships, with cookies marked `Secure`.
      // Browsers accept them on http://localhost.
      command: `pnpm build && pnpm preview --port ${port} --strictPort`,
      port,
      reuseExistingServer: !process.env.CI,
    },
  ],
  // Every sign-up hashes a password with Argon2id on the backend, which takes
  // a while when the workers sign up at once.
  expect: { timeout: 15_000 },
  use: {
    trace: "retain-on-failure",
    baseURL: `http://localhost:${port}`,
  },
  testDir: "e2e",
});
