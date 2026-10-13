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

- `examples/react-minimal` — the core component with the `anonymous` method.
- `examples/react-password` — the core component with the `usernamePassword`
  method.
- `examples/react-email-password` — the core, password, and email components
  with the `emailPassword` method: sign-up with email validation, change
  password/email, and password recovery.

Their tests run as part of `pnpm test` at the repo root.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to develop in this repo.
