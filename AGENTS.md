This is Convex Auth, an authentication framework built on top of Convex. We’re currently bulding the v2 version of the system, where individual auth providers are implemented as Convex components.

## Repository layout

This is a pnpm monorepo:

- `packages/core` — the auth package, published as `@convex-dev/auth`. Owns sessions, accounts, and JWT minting (the provider-agnostic core), plus the bundled providers: the anonymous provider and the password provider (which stores and verifies passwords keyed by an opaque user id). It also owns two non-provider components: the username component, which maps a username onto an opaque user id, and the TOTP component, which stores and verifies TOTP secrets and backup codes keyed by an opaque user id.
- `packages/argon2id-wasm` — the `argon2id-wasm` package wrapping the argon2id WASM hasher used by the password provider. It publishes compiled JavaScript plus declarations from `dist/`, so consumers never typecheck its source. Its `prepack` script builds the Rust/WASM output and then compiles the TypeScript wrapper, which keeps the Rust toolchain a publish-time requirement — `pnpm install` and TypeScript-only work don't need it. `packages/core` depends on the published package, not the workspace one, for the same reason.
- `examples/` — example apps, each an in-repo Convex backend run from its own
  directory:
  - `react-minimal` wires up the core with the anonymous provider.
  - `react-password` wires up the core with the password provider.
  - `react-email-password` wires up the core, password, and email components
    with the `EmailPassword` provider (sign-up with email validation, change
    password/email, password recovery; email through `@convex-dev/resend`).

## Source layout of `packages/core/src`

- `component/` — the core Convex component (`auth`): sessions, accounts, JWTs.
- `components/<name>/` — the optional Convex components (`username`,
  `password`, `email`, `passkey`, `totp`, `anonymous`, `oauth`, `google`,
  `apple`, `github`).
- `methods/<method>/` — the sign-in methods, which use one or more
  components: `server.ts` (Convex functions of the app), `react.tsx` (hooks),
  and the browser code.
- `server/` — the app-side code of the core (`setupConvexAuth`, `getAuthUserId`).
- `ssr/`, `react/`, `browser/` — the client and SSR code of the core.
  `ssr/nextjs/` holds the Next.js bindings.
- `lib/` — internal code that several layers share (`lib/oauth/` for the
  OAuth components and methods).
- `testing/` — the `convex-test` helpers, which ship as source.

The Convex CLI deploys every module in a component directory, and codegen
lists each one in `_generated/api.ts`. Thus a component directory holds only
the code of the component. Put the other code in the directory of its layer,
as the list above shows: the code of a sign-in method in `methods/<method>/`,
the app-side code of the core in `server/`, the client and SSR code of the
core in `ssr/`, `nextjs/`, `react/`, or `browser/`, and shared code in
`lib/`. ESLint rejects a component module that imports client code or
app-side code. The CLI skips a file name with two dots (`x.test.ts`,
`x.fixture.ts`): use the `.fixture.ts` suffix for a test-only module in a
component directory.

## Published output

`@convex-dev/auth` ships **compiled** ESM plus declarations under `dist/`; its
`exports` map points there, never at `src/` (`argon2id-wasm` does the same). This matters:
a package whose `exports` resolve to `.ts` gets typechecked by the consumer's
`tsconfig.json`, so our source would have to satisfy _their_ `lib`, `types`,
and `verbatimModuleSyntax` settings. Two rules follow from it:

- Relative imports in `packages/core/src` carry the extension of the file on
  disk (`./cookies.ts`, `./client.tsx`). `packages/core/tsconfig.json` sets
  `moduleResolution: NodeNext`, so an import without an extension is a compile
  error (TS2835) in the editor and in `tsc --noEmit`, and
  `rewriteRelativeImportExtensions` turns each one into `.js` in the emitted
  JavaScript, which is what Node's ESM resolver needs. Declarations keep the
  `.ts` specifier; a consumer's TypeScript reads that as the sibling `.d.ts`,
  back to TypeScript 5.0. Files under `_generated/` keep the `.js` extensions
  that `convex codegen` writes, and both spellings compile. The examples and
  docs are free to stay extensionless.
- Anything reached from a published entry point must compile. `dist/` is built
  by `tsconfig.build.json`, which excludes tests and other in-repo-only
  modules (see its `exclude` list).
- Each `exports` entry names one file. Do not use a `*`: a wildcard publishes
  every file of a directory, including the internal modules and the
  `_generated/` files of a component. `pnpm check:declarations` rejects a
  wildcard and an entry whose file does not exist.

The one exception is the `./test` and `./components/<name>/test` entries, which ship as TypeScript from
`src/`. Those helpers call `import.meta.glob`, a Vite macro that has to be
transformed by the consumer's bundler — and Vitest externalizes plain `.js`
under `node_modules` (leaving the macro intact, so it throws at import) while it
cannot externalize `.ts`. Shipping source is what makes them work. They carry
their own `/// <reference types="vite/client" />` so a consumer doesn't need
`vite/client` in their `tsconfig`. Their schema import uses the extension of
the file on disk, the same as the rest of `src/`. The consumer's `tsc` reads
these files, thus the consumer must set `allowImportingTsExtensions`; without
it, the `.ts` extension is an error (TS5097). Each example app sets it in its
`convex/tsconfig.json`, and `pnpm typecheck` catches a regression here.

Use `pnpm install` at the root. Common tasks:

- `pnpm build` — compile `packages/core` to `dist/`. Runs automatically via
  `prepare` on install; run it by hand after changing its sources if you want
  the examples to pick the change up. (`argon2id-wasm` is consumed from npm,
  so it isn't built here — see its `prepack`.)
- `pnpm codegen` — regenerate every Convex `_generated` directory.
  Can also generate the codegen for a single demo or component
  (e.g. `pnpm codegen react-passkey`)
- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm check:doc-examples` — typecheck the `ts` and `tsx` code blocks in the
  doc comments of `packages/core/src` against `dist/` (run `pnpm build`
  first). See `scripts/checkDocExamples.ts` for the names that an example can
  use without a declaration.
- `pnpm lint` — ESLint, including the Convex ESLint plugin.
- `pnpm format` — Prettier.
