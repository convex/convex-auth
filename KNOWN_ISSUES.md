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
out or expires — the same way an abandoned session row itself lingers today. Roughly
`horizon ÷ refresh interval` rows, about 60 at the defaults.

Nothing bounds how many rows a session holds. A session refreshed
pathologically often (an unthrottled client, or someone hammering `refresh`
with that session's tokens — see Rate limiting) can grow its retired rows
(read by `pruneRetiredTokens`) or, within `REFRESH_GRACE_MS`, its issued rows
(read by `redeem`) past the transaction read limits, making that session
unrefreshable. It can still be signed out, since deleting a session no longer
reads its rows.

Fix direction: a `@convex-dev/batch-worker` loop over retired `refreshTokens`
rows by `retiredAt`, mirroring `packages/core/src/components/passkey/cleanup.ts`,
to sweep orphans globally and cap the table regardless of any one session's
behavior. Bound its idle probe's range read above (the passkey version's
`gte(cursor)` is unbounded, which would put the whole index tail in the loop's
read set and thrash on OCC at refresh volume).

## Impersonation

### A script in the impersonator's browser can take the impersonator's session

During an impersonation, the impersonator's browser renders content that the
impersonated user controls. If the app has a stored cross-site scripting hole,
that user can plant a script that calls `stopImpersonating` and reads back a
session of the impersonator, usually an admin, valid for up to the session max
lifetime. In a single-page app the script can read the refresh tokens in
storage anyway. Under SSR it can call the deployment directly with the access
token and get the full token bundle, which the `httpOnly` cookie otherwise
prevents.

No design that restores the impersonator in the same browser avoids this for a
single-page app. The docs tell apps to escape user content, set a Content
Security Policy, and keep `maxDurationSeconds` short.

### Starting and stopping trust the access token alone

`impersonateUser` and `stopImpersonating` identify the caller by the access
token, like every authenticated function of the package. A leaked access token
of an impersonation session (valid 60 seconds by default) can be exchanged for
a session of the impersonator.

Fix direction: require proof of the refresh token, with a new `AuthClient`
operation and a new SSR route next to refresh and sign-out (browser code
cannot read the refresh token under SSR). That closes the SSR case only.
Belongs with step-up auth.

### Session switches that end signed out

Each of these ends with the client signed out, or signed in as the user it
asked for after a moment. None ends in the wrong identity.

- Under SSR, a server-side refresh (a page navigation that the Next.js
  middleware refreshes) can cross a start or a stop and write its cookies
  last. The cookies then hold the old session, which the core refuses to
  refresh (a suspended impersonator session, or a stopped impersonation past
  its 10 second grace period), so the next refresh signs the client out. Until
  then, at most one access-token TTL, server-rendered requests still carry the
  old session's access token.
- A client that needs longer than `IMPERSONATION_STOP_GRACE_MS` (10 seconds)
  to receive the response of a stop and authenticate again is signed out.
- A response to `impersonateUser` that is lost leaves the impersonator session
  suspended. A retry throws, and the next refresh signs the client out. The
  impersonation row stays until something deletes it, like any abandoned
  session.
- If the old access token expires while a start is under way and a crossing
  refresh found no session, the Convex client reports unauthenticated until
  the response of the start arrives.
- A browser without the Web Locks API has no cross-tab switch mutex, like it
  has no cross-tab refresh mutex (`packages/core/src/browser/mutex.ts`). Two
  tabs can then start or stop at the same instant. And a refresh from another
  tab that reaches the backend more than `REFRESH_GRACE_MS` (5 seconds) after
  a start commits, while the switching tab still waits for its response,
  clears the shared storage, which signs every tab out.
- More than `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT` (3) stops of one
  impersonation inside its grace period throw.
