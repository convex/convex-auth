import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import convexPlugin from "@convex-dev/eslint-plugin";

const convexRecommended = convexPlugin.configs.recommended[0].rules;

export default defineConfig([
  {
    ignores: [
      "**/_generated/**",
      // Generated data files, for example the list of frequent passwords.
      "**/*.generated.ts",
      "**/node_modules/**",
      "**/dist/**",
      ".agents/**",
      ".context/**",
      ".pnpm-store/**",
      "packages/argon2id-wasm/rust/pkg/**",
      // Generated wasm-bindgen output.
      "packages/argon2id/src/argon2-wasm/pkg/**",
      // Generated output in the docs package (Docusaurus).
      "packages/docs/.docusaurus/**",
      "packages/docs/build/**",
      // Re-export shims written by packages/docs/scripts/generate-api-reference.mjs.
      "packages/core/.api-entrypoints/**",
      // Generated Next.js output in the examples.
      "examples/**/.next/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.config.ts",
            "packages/*/vitest.config.ts",
            "examples/*/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: [
      "**/convex/**/*.{js,ts}",
      "packages/*/src/components/**/*.ts",
      "packages/*/src/component/**/*.ts",
      "packages/*/src/methods/**/*.ts",
      "packages/*/src/server/**/*.ts",
      "packages/*/src/lib/oauth/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    plugins: {
      "@convex-dev": convexPlugin,
    },
    rules: convexRecommended,
  },
  {
    // The Convex CLI deploys every module of a component directory. A
    // component module must thus not import client code or app-side code:
    // the bundle of the component would include it.
    files: [
      "packages/core/src/component/**/*.{ts,tsx}",
      "packages/core/src/components/**/*.{ts,tsx}",
    ],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/*.fixture.ts",
      "packages/core/src/components/*TestSetup.ts",
      "packages/core/src/components/password/scripts/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["react", "react-dom", "convex/react", "next"].map((name) => ({
            name,
            message: "A component module must not import client code.",
          })),
          patterns: [
            {
              group: [
                "react/*",
                "react-dom/*",
                "next/*",
                "@simplewebauthn/browser",
              ],
              message: "A component module must not import client code.",
            },
            {
              regex:
                "^\\.{1,2}/(?:.*/)?(?:methods|server|ssr|browser|react|nextjs|testing)/",
              message:
                "A component module must not import app-side code or client code. Put the shared code in the component or in src/lib/.",
            },
          ],
        },
      ],
    },
  },
]);
