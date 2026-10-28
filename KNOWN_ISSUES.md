# Known issues

Consciously deferred limitations, most should be addressed prior to v2 release.

## Rate limiting

Probably all public routes need rate limiting of some sort.

## OAuth component documents are never cleaned up, and `startSignIn` is unauthenticated

Expired authorization requests and tickets are only deleted when their
secret is later presented (`packages/core/src/lib/oauth/dbHelpers.ts`),
so abandoned flows accumulate forever.

## OAuth sign-in requires a backend with system env vars in components

An oauth component builds its callback URL from `CONVEX_SITE_URL` with its
`httpPrefix` applied (`packages/core/src/lib/oauth/dbHelpers.ts`), which
components only see on backends with convex-backend@64c163a
(self-hosted minimum release `precompiled-2026-07-28-f0d0b8b`, July 28,
2026). Cloud always has it; an older self-hosted backend fails the first
sign-in with an explicit error naming this requirement.

No action item, just here for awareness.

## One pending OAuth flow per storage

The client keeps a single pending-flow key (`flow` in the oauth setup's
scoped storage, `packages/core/src/methods/oauth/client.ts`). Two sign-ins running concurrently in
different tabs overwrite each other, and both fail recoverably (`expired` /
`invalid_flow`); retrying works.

Fix direction: keyed pending flows selected by a non-secret flow id carried
in the redirect URL. The state itself must still never be read from the URL,
preserving the login-CSRF property.

## Support for custom url schemes (eg., React Native)

`allowedRedirectOrigins` entries must be http(s) origins - custom schemes
(`myapp://`, `exp://`) have a `"null"` origin under the URL standard and are
rejected at setup (`packages/core/src/lib/oauth/redemption.ts`), so React
Native apps must return via https universal links / app links.

React Native also has no page URL for the client to work from: it defines
`window` but no `window.location`. So the startup handler that finishes a flow
from callback params does nothing there, and `signIn` requires an explicit
`redirectTo` (`packages/core/src/methods/oauth/client.ts`). Supporting React Native
properly means deciding what `redirectTo` looks like when it can't be a page
URL.

## Refresh-token reuse detection has a bounded horizon

A spent or dropped refresh token is remembered for `SPENT_TOKEN_HORIZON_MS`
(1 hour) after it is retired, and pruned when the same session next redeems a
token.

Retired rows are pruned inline by the refreshes of their own session, so a
session abandoned mid-life leaves its remaining rows behind until it is signed
out or expires, when the session cleanup loop
(`packages/core/src/component/cleanup.ts`) erases them with the session. Roughly
`horizon ÷ refresh interval` rows, about 60 at the defaults.

Nothing bounds that per-session set independently, and both `pruneRetiredTokens`
and `deleteSession` read all of it. At any plausible refresh rate that is a
few dozen rows, but a session refreshed pathologically often (an unthrottled
client, or an attacker hammering `refresh` — see the rate-limiting entry above)
could grow it until those reads exceed the transaction's limits, which would
make the session unrefreshable and un-signoutable. Accepted for now on the
basis that the sweep below lands first.

Fix direction: a sweep of the retired `refreshTokens` rows by `retiredAt`,
over the `by_state` index that the session cleanup loop already scans for
issued tokens, to erase an abandoned session's rows an hour after they retire
rather than when the session expires. Rows are retired by refreshes, which the
session loop deliberately doesn't ping from, so the sweep would need its own
wake-up schedule. Note that it would not help the pathological case above:
those rows are within the horizon, which no sweep may erase without giving up
the detection.
