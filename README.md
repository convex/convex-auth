> [!NOTE]
> Looking for Convex Auth v1? This branch contains a WIP implementation of
> Convex Auth v2. For the current stable release, see the
> [`main` branch](https://github.com/convex/convex-auth/tree/main).

# Convex Auth v2

This branch contains a WIP implementation of Convex Auth v2.

## Getting Started

TODO: Write the v2 README.

## Examples

The `examples/` directory holds in-repo example apps. Each is a self-contained
Convex backend that mounts the auth components, and is run from its own
directory (see the example's own README):

- `examples/react-minimal` — the core and anonymous components with the
  `anonymous` method.
- `examples/react-password` — the core, password, and username components
  with the `usernamePassword` method.
- `examples/react-email-password` — the core, password, and email components
  with the `emailPassword` method: sign-up with email validation, change
  password/email, and password recovery.
- `examples/react-passkey` and `examples/react-passkey-basic` — the core,
  passkey, and username components with the `usernamePasskey` method.
- `examples/react-google`, `examples/react-apple`, and `examples/react-github`
  — the core and OAuth components with the `google`, `apple`, and `github`
  methods.
- `examples/nextjs` — a Next.js app with SSR sign-in.

The tests of the examples run as part of `pnpm test` at the repo root.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to develop in this repo.
