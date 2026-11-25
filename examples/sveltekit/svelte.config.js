import adapter from "@sveltejs/adapter-auto";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    typescript: {
      // Typecheck the e2e tests with the app.
      config: (tsconfig) => {
        tsconfig.include.push("../e2e/**/*.ts", "../playwright.config.ts");
      },
    },
  },
};

export default config;
