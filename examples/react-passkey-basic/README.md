# react-passkey-basic example

> [!WARNING]
> This demo is intentionally kept incomplete because it is used as a first step in the passkey tutorial. You should probably not implement an app that doesn’t support passkey management. See [**react-passkey**](../react-passkey/README.md) for a full demo.

This demo is a simplified version of the [react-passkey](../react-passkey/README.md) demo that doesn’t support passkey management (i.e. the ability for user to add or remove passkeys).

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-passkey-basic
npx convex dev --once    # provisions a deployment, generates convex/_generated
npm run dev              # start the Vite frontend
```

## Deploying

Before you deploy, set `rpId` and `origin` in `convex/auth.ts` to the
production domain. Passkeys are permanently bound to the `rpId`.
