# react-passkey example

This demo shows:

- The core component.
- The passkey component, with the identifier-first `usernamePasskey`
  method: one username field. A free username creates a new account with
  a passkey; an existing username asks for a passkey of that account. The
  login field also offers passkey autofill (WebAuthn conditional
  mediation).

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-passkey
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx @convex-dev/auth     # sets AUTH_PRIVATE_KEY + AUTH_JWKS on the deployment
npm run dev              # start the Vite frontend
```

## Deploying

Before you deploy, set `rpId` and `origin` in `convex/auth.ts` to the
production domain. Passkeys are permanently bound to the `rpId`.
