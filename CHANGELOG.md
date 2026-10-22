# Changelog

## Unreleased

- `ConvexAuthNextjsServerProvider` no longer renders the Convex client
  provider itself. Render `ConvexAuthNextjsProvider`, now exported from
  `@convex-dev/auth/ssr/nextjs/client`, in a Client Component inside it and
  pass it your `ConvexReactClient`, so the client can be configured and shared
  (e.g. with `ConvexQueryClient`). `setupConvexAuthNextjs` takes `routes` for
  auth handlers mounted away from `/auth/*`.

## 2.0.0-beta.0

Some API and schema breaking changes - see below

- added the email component and the EmailPassword method (sign-up with
  email validation, sign-in, password change/recovery, email change), with
  React hooks and the react-email-password example
- gave Google and GitHub their own OAuth components; OAuth now works under
  `ConvexAuthNextjsProvider`
- reworked session refresh for more reliable behavior; requires clearing the
  `auth/sessions` table due to a schema change
- renamed the React hooks and the `auth.ts` functions, reorganized
  import paths, replaced wildcard exports with explicit entries, prefixed
  component names with `auth`

## 2.0.0-alpha.2

- added passkey management support (add/remove/rename)
- added change password support
- added Apple OAuth support
- hardened refresh token reuse prevention
- switched to SimpleWebAuthn for passkeys

## 2.0.0-alpha.1

Initial v2 alpha

- no major dependencies
- supports password, passkey, google, github providers
- nextjs ssr support for password, passkey

## 0.0.95

- fix: a failed OTP/magic-link sign-in no longer consumes the verification code
  it rejected
- fix: `signIn` called with only a `code` now resolves with `{ tokens: null }`
  for every failure instead of rejecting for some

## 0.0.94

- chore: bump `@auth/core` peer dependency (#320) @eden881

## 0.0.93

- fix: downgrade log levels for expected auth flows (#336) @Hades32

## 0.0.92

- feat: expose useAuth (#326) @Hades32
- fix: shorten test provider id to fix deploy-blocking env var name (#300)

## 0.0.91

- feat: add `jwt.customClaims` hook for custom JWT claims (#298) @Hades32
- feat: add `beforeSessionCreation` callback hook (#296) @focus-stefano
- fix: password reset code not validated against email (#285)
- fix: restore isLoading guard during URL code sign-in (#288)
- fix: window is undefined bug (#277) @nyoung697
- fix: use shx for cross-platform build scripts (#290)
- fix: remove clean git tree requirement from setup CLI (#297)
- docs: update nextjsMiddlewareRedirect (#244) @johncmunson
- docs: update server.mdx createAccount() (#247) @CodeZeno

## 0.0.90

- fix negative `shouldHandleCode` logic for client

## 0.0.89

- Accept `shouldHandleCode` as a boolean or function, and support async function
  in middleware.

## 0.0.88

- Add new cli options `--allow-dirty-git-state` and `--web-server-url <url>` to
  enable running non-interactively.

## 0.0.87

- Add missing `shouldHandleCode` prop to Next.js server provider

## 0.0.86

- Fix RN enviornment checks for Expo 53+ for real

## 0.0.85

- Fix RN enviornment checks for Expo 53+

## 0.0.84

- Accept `shouldHandleCode` in ConvexAuthProvider

## 0.0.83

- Fix auth error messages not propagating from backend to client for Next.js

## 0.0.82

- Add `shouldHandleCode` prop to React/Next.js clients and Next.js middleware to
  allow for custom code handling.

## 0.0.81

- Retry token fetch on network errors
- Update the CLI script to work in non-interactive terminals

## 0.0.80

- Fix a race when quickly refreshing a page or using redirects that refresh the
  page.

## 0.0.79

- Expose function reference types `SignInAction` and `SignOutAction` for the
  benefit of other client implementations (Svelte, Solid, etc.). As with all
  APIs in the library these are not stable and may change until this library
  reaches 1.0.

- Add a platform check in the recommended `ConvexAuthProvider` use for React
  Native in docs.

- Fix auth refresh silent failure for React Native. This has been a slippery
  issue, if you use Convex Auth in a React Native app please let us know if this
  fixes for you.

## 0.0.78

- Add support for
  [custom OAuth callback and sign-in URLs](https://labs.convex.dev/auth/advanced#custom-callback-and-sign-in-urls)

- Next.js middleware function `isAuthenticated` fails more loudly; previously it
  returned false in the case of a Convex backend that didn't expose an endpoint
  called `auth:isAuthenticated`, now it throws an error. This should help people
  with the migration required for 0.0.76.

## 0.0.77

- Fix syntax of an import to work with convex-test.

## 0.0.76

- BREAKING: A change in the logic for isAuthenticated for Next.js: it now
  involves a server-side check. Update your auth.ts file by adding a new
  `isAuthenticated` endpoint to the list of exported Convex functions, like

  ```
  export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth(...
  ```

  If you're not using Next.js, you should still add this named export as it's
  the new suggested set of publicly exposed endpoints, but nothing should break
  if you don't.

- Potentially breaking: For NextJS, switched to `path-to-regexp` 6.3.0 to avoid
  ReDoS vulnerability. That version, while protected from the vulnerability, has
  less expressive RegEx pattern support. If you are using `createRouteMatcher`
  in middleware, it might not match some patterns that were previously available
  in the 0.7.x series. See the docs for supported patterns:
  https://www.npmjs.com/package/path-to-regexp/v/6.3.0.
- Upgraded to `@auth/core` 0.37.3. You may need upgrade @auth/core to "~0.37.3".
- Updated OAuth integration docs for supported providers (available at
  https://labs.convex.dev/auth/config/oauth).

## 0.0.75

- BREAKING: `convexAuthNextjsToken()` and `isAuthenticatedNextjs()` now return
  promises so must be `await`ed.
- Support for Next.js 15.
- Update convex peer dependency to ^1.17.0

## 0.0.74

- Fix to header propagation in Next.js middleware
- Update Password provider to separate password requirement validation from
  custom profile information
  - **Breaking** If using Password with a custom profile to enforce password
    requirements, you must now implement `validatePasswordRequirements`

## 0.0.73

- Update implementation of refresh tokens reuse **Note:** After upgrading to
  this version, downgrading will require migrating the `authRefreshTokens` table
  to drop the `parentRefreshTokenId` field.
- Add configuration for cookie age in Next.js middleware

## 0.0.72

- Upgrade + pin `@auth/core` to 0.36.0 to avoid issues with mismatched types

## 0.0.71

- Fix bug with setting auth cookies on Next.js response

## 0.0.70

- Improve error handling when calling Convex auth functions from Next.js

## 0.0.69

- Add a 10s reuse window for refresh tokens

**Note:** After upgrading to this version, downgrading will require migrating
the `authRefreshTokens` table to drop the `firstUsedTime` field.

- Fix exported type for `signIn` from `convexAuth`

## 0.0.68

- [Next.js] Propagate auth cookies in middleware follow up
- Introduce `convexAuth.isAuthenticated()` and `convexAuth.getToken()` in favor
  of `isAuthenticatedNextJs()` and `convexAuthNextJsToken()` for middleware.

## 0.0.67

- [Next.js] Propagate auth cookies in middleware

## 0.0.66

- [Next.js] Match auth routes to proxy to Convex with and without trailing slash

## 0.0.65

- Add verbose logging to Next.js middleware

## 0.0.64

- Fix issue with re-entrant `fetchAccessToken` with a mutex

---

Previous versions are documented in git history.
