# react-minimal example

An in-repo Convex backend that mounts the `@convex-dev/auth` components. It
exists as an example of wiring the auth system to an application and for unit
testing the auth system.

The auth system owns sessions, providers, accounts, and JWT minting;
`convex/users.ts` owns the app side (the `createUser` callback). Providers from the auth system expose sign in methods.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-minimal
npx convex dev --once    # provisions a deployment, generates convex/_generated
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
