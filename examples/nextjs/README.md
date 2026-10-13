# Convex Auth — Next.js (App Router) SSR example

Server-side sign-in with Convex Auth — username/password, GitHub, or
anonymous: the refresh token is minted straight into an httpOnly cookie and
**never reaches client JS**. The browser holds only the access token.

## How it works

- **Sign-in / refresh / sign-out run on the server** as framework-agnostic
  `(Request) => Response` handlers, mounted under `app/auth/`:
  - `app/auth/signin/route.ts` → `convexProxyHandler`, the one route serving
    every sign-in method
  - `app/auth/refresh/route.ts` → `refreshHandler`
  - `app/auth/signout/route.ts` → `signOutHandler`
- **The sign-in route** speaks the same HTTP interface as `ConvexHttpClient` and
  forwards calls to the deployment, intercepting only the minted refresh token
  on the way back to put it in the cookie. Because of that, a method needs no
  SSR-specific client hook: `app/signin/page.tsx` imports the _same_
  `useAnonymousAuth` a SPA would, from
  `@convex-dev/auth/methods/anonymous/react`.
- **Adding an auth method** means adding its function to `signIn` in
  `src/lib/serverAuth.ts`. That allowlist is the route's entire API surface;
  there is no per-method route and no per-method client code.
- **`src/lib/convexAuth.tsx`** wires the Next-specific helpers via
  `setupConvexAuthNextjs`: the proxy (up-front refresh + redirects, mounted in
  `proxy.ts`), the Server-Component token accessor
  `convexAuthNextjsAccessToken`, and `ConvexAuthNextjsServerProvider`
  (hydrates the client from the cookie).
- **`app/signin/page.tsx` / `app/signup/page.tsx`** use the username-password
  method's own `useSignInWithPassword` / `useSignUpWithPassword` from
  `@convex-dev/auth/methods/username-password/react`, the same hooks a SPA uses. The
  proxy forwards the call and adopts the access-only session it returns. On
  failure the action's `userError` (e.g. `INVALID_CREDENTIALS`,
  `USERNAME_TAKEN`) comes back fully typed, so the form can show a specific
  message. The sign-in page also offers one-click anonymous sign-in.
- **GitHub sign-in** uses `useSignInWithGithub` from
  `@convex-dev/auth/methods/github/react`, the same hook a SPA uses. Starting
  the flow runs `startSignInWithGithub` on the Convex client, because it returns a
  redirect URL rather than a session. GitHub sends the user back to `/signin`,
  where the hook redeems the code by calling `completeSignInWithGithub` through the
  sign-in route, so of the OAuth pair only `completeSignInWithGithub` is in the
  `signIn` allowlist.
  The flow has to return to a page `proxy.ts` lets a signed-out user reach,
  which is why it starts and ends on `/signin`.

## Run it

```sh
cd examples/nextjs
npx convex dev --once   # provisions a deployment, generates convex/_generated
npm run dev             # runs Convex and next dev together
```

For GitHub sign-in, register a GitHub OAuth app whose callback URL is your
deployment's site URL plus `/oauth/github/callback` (get the site URL with
`npx convex env get CONVEX_SITE_URL`), then set its credentials:

```sh
npx convex env set AUTH_GITHUB_CLIENT_ID YOUR_GITHUB_OAUTH_CLIENT_ID
npx convex env set AUTH_GITHUB_CLIENT_SECRET YOUR_GITHUB_OAUTH_CLIENT_SECRET
```

Then open <http://localhost:3000> — you'll be redirected to `/signin`; create an
account at `/signup`.
