> [!NOTE]
> Looking for Convex Auth v1? It's no longer the recommended auth solution,
> but it will be receiving security updates for the time being. Find it in
> the [`v1` branch](https://github.com/convex/convex-auth/tree/v1).

# Convex Auth

Transactional, reactive authentication for your [Convex](https://convex.dev/)
applications. Type checked end-to-end and 100% agent friendly.

Supported sign-in methods:

- Username + password
- Email + password, with email verification and password recovery
- Username + passkey
- OAuth: Google, Apple, GitHub and Discord

## Getting Started

Here's a quick start guide to adding username + password login to a Convex application.

Install the package.

```sh
npm i @convex-dev/auth
```

Register the required Convex Auth components in `convex/convex.config.ts`.

```ts title="convex/convex.config.ts"
import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";

const app = defineApp();

app.use(auth);
app.use(authPassword);
app.use(authUsername);

export default app;
```

Run `npx convex dev` to generate the code for the components in
`convex/_generated`. Keep it running while you add the files below.

Create `convex/auth.config.ts`. This file tells your deployment to accept the
access tokens of Convex Auth:

```ts title="convex/auth.config.ts"
import type { AuthConfig } from "convex/server";
import { convexAuthProvider } from "@convex-dev/auth/server";

export default {
  providers: [convexAuthProvider()],
} satisfies AuthConfig;
```

Create `convex/auth.ts`. It sets up the core and the username + password
sign-in method, and exports their functions.

```ts title="convex/auth.ts"
import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  signUpWithUsernamePassword,
  signInWithUsernamePassword,
  changePassword,
} = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser });
```

Add a `users` table to `convex/schema.ts`. The following adds an
empty one for this simple example.

```ts title="convex/schema.ts"
import { defineSchema, defineTable } from "convex/server";

export default defineSchema({
  users: defineTable({}),
});
```

Create an internal mutation for creating a new user record.

```ts title="convex/users.ts"
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new password account and return its id. This
 * example keeps no data in the row, but your app can put a profile here.
 */
export const createUser = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("password"),
      accountId: v.string(),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
```

That's enough to get the backend up and running with Convex Auth. On the
client, the `useSignUpWithUsernamePassword` and `useSignInWithUsernamePassword`
hooks from `@convex-dev/auth/methods/username-password/react` call these
functions. See the examples below for minimal working end-to-end applications
demonstrating the different sign-in methods.

## Documentation

This `README` is just the start. Learn more about Convex Auth in the
[full documentation](https://docs.convex.dev/auth/convex-auth).

## Examples

The `examples/` directory holds in-repo example apps. Each is a self-contained
Convex backend that mounts the auth components, and is run from its own
directory (see the example's own README):

- `examples/react-password` — the core, password, and username components
  with the `usernamePassword` method.
- `examples/react-email-password` — the core, password, and email components
  with the `emailPassword` method: sign-up with email validation, change
  password/email, and password recovery.
- `examples/react-passkey` and `examples/react-passkey-basic` — the core,
  passkey, and username components with the `usernamePasskey` method.
- `examples/react-google`, `examples/react-apple`, `examples/react-github`, and
  `examples/react-discord` — the core and OAuth components with the `google`,
  `apple`, `github`, and `discord` methods.
- `examples/nextjs` — a Next.js app with SSR sign-in.

The tests of the examples run as part of `pnpm test` at the repo root.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to develop in this repo.
