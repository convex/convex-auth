# react-impersonation example

This demo shows:

- The core component.
- The password and username components, with the `usernamePassword`
  method.
- Impersonation: an admin acts as another user, and goes back to their own
  session. See `convex/auth.ts` (`setupImpersonation`), `convex/users.ts`
  (the `authorizeImpersonation` rule), and `src/ImpersonationBanner.tsx`.

The first user who signs up is the admin. Sign up a second user in another
browser profile, then act as them from the admin's dashboard.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-impersonation
npx convex dev --once    # provisions a deployment, generates convex/_generated
npm run dev              # start the Vite frontend
```

## Test usage

The tests defined in the example are run along with `pnpm test` in the repo root.
