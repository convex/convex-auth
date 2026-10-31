# react-workos example

This demo shows:

- The core component.
- The WorkOS component, with the `workos` method: enterprise SSO routed by
  the email's verified domain.
- The component's copy of WorkOS, with `dsync.user.*` callbacks that sign a
  deprovisioned user out everywhere.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-workos
npx convex dev --once    # provisions a deployment, generates convex/_generated
```

Then set `AUTH_WORKOS_CLIENT_ID` and `AUTH_WORKOS_API_KEY` on the deployment,
add `<site-url>/workos/callback` as a redirect URI in the WorkOS dashboard,
then register the deployment's webhook endpoint at WorkOS and fill the copy:

```bash
npx convex run auth:syncWorkos
```

Run it after every deploy. Before deleting the deployment, delete its
endpoint:

```bash
npx convex run auth:unregisterWorkos
```
