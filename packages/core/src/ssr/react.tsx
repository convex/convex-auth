/**
 * The client side of Convex Auth under SSR, for frameworks other than Next.js
 * (TanStack Start, React Router, Remix, …).
 *
 * Pair it with the framework-agnostic server helpers of `@convex-dev/auth/ssr`
 * (`setupConvexAuthServer`, `ServerAuthSession`): render
 * {@link ConvexAuthSsrProvider} around the app and point its `signInRoute`,
 * `refreshRoute` and `signOutRoute` at the routes that mount those helpers.
 * Next.js apps use `@convex-dev/auth/ssr/nextjs`, which renders this provider
 * for them.
 *
 * @module
 */
"use client";

export { ConvexAuthNextjsProvider as ConvexAuthSsrProvider } from "./nextjs/client.tsx";
