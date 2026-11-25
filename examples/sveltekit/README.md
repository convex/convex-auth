# Convex Auth — SvelteKit SSR example

Server-side sign-in with Convex Auth — username/password or GitHub: the refresh
token is minted straight into an httpOnly cookie and **never reaches client
JS**. The browser holds only the access token. It is the SvelteKit counterpart
of the [Next.js example](../nextjs), with the same backend.

## How it works

- **Sign-in / refresh / sign-out run on the server** as framework-agnostic
  `(Request) => Response` handlers, mounted under `src/routes/auth/`:
  - `src/routes/auth/signin/+server.ts` → `convexProxyHandler`, the one route
    serving every sign-in method
  - `src/routes/auth/refresh/+server.ts` → `refreshHandler`
  - `src/routes/auth/signout/+server.ts` → `signOutHandler`
- **The sign-in route** speaks the same HTTP interface as `ConvexHttpClient`
  and forwards calls to the deployment, intercepting only the minted refresh
  token on the way back to put it in the cookie. Because of that, a method
  needs no SSR-specific client hook: `src/routes/signin/+page.svelte` imports
  the _same_ `useSignInWithUsernamePassword` a client-only Svelte app would,
  from `@convex-dev/auth/methods/username-password/svelte`.
- **Adding an auth method** means adding its function to `signIn` in
  `src/lib/server/serverAuth.ts`. That allowlist is the route's entire API
  surface; there is no per-method route and no per-method client code.
- **`src/lib/server/convexAuth.ts`** wires the SvelteKit-specific helpers via
  `setupConvexAuthSvelteKit`: the `handle` hook (up-front refresh + redirects,
  mounted in `src/hooks.server.ts`), and the access token that
  `src/routes/+layout.server.ts` hands to the client.
- **`src/routes/+layout.svelte`** calls `setupConvexAuthSvelteKit` of
  `@convex-dev/auth/ssr/sveltekit/client` in place of `setupConvex`, which
  hydrates the client from that token.
- **`src/routes/+page.server.ts`** runs the authenticated `loggedInUser` query
  on the server, so the page renders signed in on the first request, and
  `src/routes/+page.svelte` keeps it live with `useQuery` of `convex-svelte`.
- **GitHub sign-in** uses `useSignInWithGithub` from
  `@convex-dev/auth/methods/github/svelte`. Starting the flow runs
  `startSignInWithGithub` on the Convex client, because it returns a redirect
  URL rather than a session. GitHub sends the user back to `/signin`, where the
  helper redeems the code by calling `completeSignInWithGithub` through the
  sign-in route, so of the OAuth pair only `completeSignInWithGithub` is in the
  `signIn` allowlist. The flow has to return to a page the `handle` hook lets a
  signed-out user reach, which is why it starts and ends on `/signin`.

## Run it

```sh
cd examples/sveltekit
npx convex dev --once   # provisions a deployment, writes PUBLIC_CONVEX_URL to .env.local
npm run dev             # runs Convex and vite dev together
```

For GitHub sign-in, register a GitHub OAuth app whose callback URL is your
deployment's site URL plus `/oauth/github/callback` (get the site URL with
`npx convex env get CONVEX_SITE_URL`), then set its credentials:

```sh
npx convex env set AUTH_GITHUB_CLIENT_ID YOUR_GITHUB_OAUTH_CLIENT_ID
npx convex env set AUTH_GITHUB_CLIENT_SECRET YOUR_GITHUB_OAUTH_CLIENT_SECRET
```

Then open <http://localhost:5173> — you'll be redirected to `/signin`; create
an account at `/signup`.

## Run the e2e tests

The Playwright tests in `e2e/` run a production build (`vite build && vite
preview`) against the deployment of `.env.local`, and start `npx convex dev`
for it. They create their own users through the sign-up page and stop at
GitHub's page, so the GitHub credentials can be any value. CI runs them
against a local deployment that needs no Convex account
(`CONVEX_AGENT_MODE=anonymous`, see `.github/workflows/e2e.yml`).

```sh
npx playwright install chromium
npm run test:e2e
```
