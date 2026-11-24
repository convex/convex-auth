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
      // Claude Code worktrees.
      ".claude/**",
      ".pnpm-store/**",
      // Generated wasm-bindgen output.
      "packages/password-hash-wasm/rust/pkg/**",
      // Generated output in the docs package (Docusaurus).
      "packages/docs/.docusaurus/**",
      "packages/docs/build/**",
      // Re-export shims written by packages/docs/scripts/generate-api-reference.mjs.
      "packages/core/.api-entrypoints/**",
      // Generated Next.js output in the examples.
      "examples/**/.next/**",
      // Generated SvelteKit output in the examples.
      "examples/**/.svelte-kit/**",
      "examples/sveltekit/build/**",
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
          paths: [
            "react",
            "react-dom",
            "convex/react",
            "next",
            "svelte",
            "convex-svelte",
            "@sveltejs/kit",
          ].map((name) => ({
            name,
            message: "A component module must not import client code.",
          })),
          patterns: [
            {
              group: [
                "react/*",
                "react-dom/*",
                "next/*",
                "svelte/*",
                "convex-svelte/*",
                "@sveltejs/*",
                "$app/*",
                "@simplewebauthn/browser",
              ],
              message: "A component module must not import client code.",
            },
            {
              regex:
                "^\\.{1,2}/(?:.*/)?(?:methods|server|ssr|browser|react|nextjs|svelte|sveltekit|testing)/",
              message:
                "A component module must not import app-side code or client code. Put the shared code in the component or in src/lib/.",
            },
          ],
        },
      ],
    },
  },
  {
    // The framework-agnostic code: the core client, the shared code, the
    // browser clients of the methods, which every binding (React, Svelte, or
    // another framework) builds on, and the SSR modules that the Next.js and
    // SvelteKit bindings share (`ssr/*.ts`, not `ssr/nextjs/` or
    // `ssr/sveltekit/`). It must thus not import React, Next.js or Svelte, or
    // a module of their bindings: a `react/`, `nextjs/`, `svelte/` or
    // `sveltekit/` directory, a `react*` or `svelte*` module, a `.tsx`
    // module, or a `.svelte.ts` module.
    files: [
      "packages/core/src/browser/**/*.ts",
      "packages/core/src/lib/**/*.ts",
      "packages/core/src/methods/**/*.ts",
      "packages/core/src/ssr/*.ts",
    ],
    ignores: [
      "**/*.test.ts",
      "**/*.fixture.ts",
      // The React hooks of the OAuth providers.
      "packages/core/src/methods/*/react.ts",
      // The Svelte helpers of the methods.
      "packages/core/src/methods/*/svelte.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...["react", "react-dom", "convex/react", "next"].map((name) => ({
              name,
              message:
                "A framework-agnostic module must not import React or Next.js. Put the code in a React binding: the react module of a method, react/, or ssr/nextjs/.",
            })),
            ...["svelte", "convex-svelte", "@sveltejs/kit"].map((name) => ({
              name,
              message:
                "A framework-agnostic module must not import Svelte. Put the code in a Svelte binding: the svelte module of a method, svelte/, or ssr/sveltekit/.",
            })),
          ],
          patterns: [
            {
              group: ["react/*", "react-dom/*", "next/*"],
              message:
                "A framework-agnostic module must not import React or Next.js. Put the code in a React binding: the react module of a method, react/, or ssr/nextjs/.",
            },
            {
              group: ["svelte/*", "convex-svelte/*", "@sveltejs/*", "$app/*"],
              message:
                "A framework-agnostic module must not import Svelte. Put the code in a Svelte binding: the svelte module of a method, svelte/, or ssr/sveltekit/.",
            },
            {
              regex:
                "^\\.{1,2}/(?:.*/)?(?:react/|nextjs/|react(?:[._-][^/]*)?$|[^/]*\\.tsx$)",
              message:
                "A framework-agnostic module must not import a module of the React or Next.js bindings.",
            },
            {
              regex:
                "^\\.{1,2}/(?:.*/)?(?:svelte/|sveltekit/|svelte(?:[._-][^/]*)?$|[^/]*\\.svelte\\.ts$)",
              message:
                "A framework-agnostic module must not import a module of the Svelte or SvelteKit bindings.",
            },
          ],
        },
      ],
    },
  },
  {
    // Svelte compiles runes only in `.svelte.ts` modules, so no other module
    // may use them. Svelte declares them as globals, which `tsc` thus
    // accepts anywhere.
    files: ["packages/core/src/**/*.{ts,tsx}"],
    // `.svelte.test.ts` and `.svelte.fixture.ts` modules compile too.
    ignores: ["**/*.svelte.ts", "**/*.svelte.*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...[
          "$state",
          "$derived",
          "$effect",
          "$props",
          "$bindable",
          "$inspect",
          "$host",
        ].map((name) => ({
          name,
          message:
            "Runes compile only in a .svelte.ts module. Move the code to one.",
        })),
      ],
    },
  },
]);
