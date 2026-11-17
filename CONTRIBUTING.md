# Developing guide

## Running locally

```sh
pnpm install
```

Then run one of the example apps from its own directory:

```sh
cd examples/react-password
pnpm dev
```

Each example is a self-contained Convex backend that mounts the auth components,
so the first `pnpm dev` prompts you to pick or create a deployment.

- `examples/react-password` uses the core component with the password provider.
- `examples/react-passkey-basic` adds the passkey provider.
- `examples/react-github` adds the GitHub Oauth provider.
- `examples/react-discord` adds the Discord OAuth provider.
- `examples/react-google` adds the Google OAuth provider.
- `examples/nextjs` covers the Next.js integration.

## Common tasks

- `pnpm build` — compile `@convex-dev/auth` to `dist/` (also runs on install
  via `prepare`).
- `pnpm test` — run tests across packages (Vitest).
- `pnpm typecheck` — typecheck across packages.
- `pnpm lint` — ESLint.
- `pnpm format` — Prettier.

## Testing

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm typecheck` covers `packages/password-hash-wasm`, which needs the generated
Rust bindings. On a fresh clone those don't exist yet, so either build them once
(see below) or skip that package:

```sh
pnpm -r --filter=!password-hash-wasm typecheck
```

## Rust code

Only `packages/password-hash-wasm` has Rust, and it changes rarely. You need a Rust
toolchain and `just`.

```sh
cd packages/password-hash-wasm/rust
just build   # regenerates pkg/, which the TypeScript wrapper imports
just test
just lint
```

`pkg/` is generated and not committed. `just build` is what makes
`pnpm typecheck` pass for this package.

## Releasing

Only `@convex-dev/auth` is released by script. `password-hash-wasm` and
`vite-plugin-wasm-module` are published by hand, see below.

### Building a one-off package

```sh
cd packages/core
pnpm pack
```

### Publishing a new version

Run from the repo root, on `main`, with a clean working tree.

For an alpha release:

```sh
pnpm alpha
```

For a beta release:

```sh
pnpm beta
```

Note that the prerelease identifiers order as `alpha` < `beta`, so moving from
beta back to alpha means editing the version by hand.

For a standard (latest tag) release:

```sh
pnpm release
```

### Publishing password-hash-wasm

Only needed when the Rust changes. Its `prepack` builds the Rust and WASM
output, so this needs the toolchain from the section above.

```sh
cd packages/password-hash-wasm
# bump the version in package.json, then
pnpm publish
```

Then update the exact `password-hash-wasm` version in `packages/core`'s dependencies
and run `pnpm install`.

### Publishing vite-plugin-wasm-module

Its `prepack` builds `dist/`.

```sh
cd packages/vite-plugin-wasm-module
# bump the version in package.json, then
pnpm publish
```
