# Component API safety audit

An inventory of every function that the components of `@convex-dev/auth`
expose to the app, with an assessment of how much each one trusts its caller.

## Threat model

A component function can be called by any code of the app, never by an
end-user client directly. The question for each function is thus: **if the app
passes it unverified, client-controlled arguments, what can an attacker do?**
A function is safe when it verifies what it needs by itself (a secret, a
signature, a code), so that an app that forwards client input as-is stays
secure.

The functions that are `internal` inside a component (the cleanup loops,
`deleteSessionTokens`, OAuth `claimAuthorizationRequest` and `createTicket`)
are not part of the component API and are not listed. The OAuth component
functions are listed once: `oauth`, `google`, `apple` and `github` register the
same four functions through `buildProviderFunctions`.

## Ratings

| Rating                    | Meaning                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 Unsafe                 | Trusts its arguments and leads to **account takeover** (or a session for an arbitrary user) when the caller has not verified them.                                                     |
| 🟠 Trusts caller, limited | Trusts a `userId` (or similar) and can do harm when misused, but no takeover: sign-out, lockout, deletion, defacement. The "invalidating" class: missing checks, but not really risky. |
| 🟡 Read by `userId`       | Read-only, trusts `userId`. Leaks data about a user if the caller does not check that the reader may see it.                                                                           |
| 🟢 Safe                   | Verifies what it needs by itself (secret, code, signature, rate limit), or has no effect worth protecting. The app can forward client input as-is.                                     |

## Summary

| Rating                    | Count |
| ------------------------- | ----: |
| 🔴 Unsafe                 |    12 |
| 🟠 Trusts caller, limited |    11 |
| 🟡 Read by `userId`       |     7 |
| 🟢 Safe                   |    22 |
| **Total**                 |    52 |

52 distinct functions; 64 counting each OAuth component separately.

The 🔴 functions fall into two groups:

1. **Session minting from a `userId`**: `auth.signIn` signs in whoever
   `userId` names. The core has no idea how the user was verified.
2. **Binding a credential to a `userId`**: `password.setPassword`,
   `passkey.finishRegistrationFor*User`, `email.{signUp,addEmail,changeEmail}.start`,
   `oauth.createAccount`, `anonymous.createAnonymousAccount`,
   `totp.createTotp`/`confirmTotp`. Each one lets an attacker who controls the
   `userId` attach a credential they own (a password, a passkey, a mailbox, a
   provider account) to the victim's account, then sign in with it.

## Full table

### `auth` (core: sessions, JWTs)

| Function               | Kind     | Rating | Assessment                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn`               | mutation |   🔴   | Mints a session for any non-empty `userId`. No check at all: the doc comment says so. Also trusts `claims` (passed to `onSignIn`), `componentPath` (recorded on the session) and the TTL config.                                                                                                                                                                                                          |
| `signUp`               | mutation |   🔴   | Creates a user through `createUserHandle` and mints a session for it. No existing user is taken over directly, but the `claims` (provider name, profile, e.g. an `email` with `emailVerified`) are trusted and handed to the app's `createUser`, which may link by email: forged claims then lead to takeover. Also bypasses any verification step (e.g. email validation) the method intends to require. |
| `signUpWithoutSession` | mutation |   🟠   | Same trust in `claims` as `signUp`, but mints no session and doesn't run `onSignIn`. Risk depends on what the app's `createUser` does with the claims (e.g. linking by email still makes it 🔴).                                                                                                                                                                                                          |
| `markUserIdCreated`    | mutation |   🟢   | Only records that an id is in use. Documented as safe to call from anywhere.                                                                                                                                                                                                                                                                                                                              |
| `getSession`           | query    |   🟢   | Maps a session id to its user id. The session id is not a credential (refreshing needs the refresh token), and the result is what the JWT already says.                                                                                                                                                                                                                                                   |
| `refresh`              | mutation |   🟢   | Requires a refresh token, looked up by hash. Unknown tokens change nothing. Reuse detection revokes forked sessions. (The TTL config is caller-provided; the app's `setupConvexAuth` must pass it, not the client.)                                                                                                                                                                                       |
| `signOut`              | mutation |   🟢   | Requires a refresh token of the session. Idempotent.                                                                                                                                                                                                                                                                                                                                                      |
| `listSessions`         | query    |   🟡   | Lists the sessions of any `userId` (ids, creation and last-refresh times).                                                                                                                                                                                                                                                                                                                                |
| `revokeSessions`       | mutation |   🟠   | Revokes any session id it gets, whoever owns it (documented NOTE + TODO for step-up auth). Misuse signs users out; no takeover.                                                                                                                                                                                                                                                                           |

### `authPassword`

| Function         | Kind     | Rating | Assessment                                                                                                                                                                                                                                                                              |
| ---------------- | -------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setPassword`    | mutation |   🔴   | Sets or **replaces** the password of any `userId`. No current password, no proof. An unverified `userId` is a direct takeover. The caller also picks `minimumLength` (bounded by the component's `MIN_PASSWORD_LENGTH`).                                                                |
| `verifyPassword` | mutation |   🟢   | This _is_ the verification, rate-limited per `userId`. Caveats: anyone who can call it can drain a user's rate-limit bucket (lockout, documented), and an unknown `userId` throws rather than returning an error, which tells apart "has a password" from "wrong password" if surfaced. |

### `authUsername`

| Function              | Kind     | Rating | Assessment                                                                                                                                                                                                                 |
| --------------------- | -------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setUsername`         | mutation |   🟠   | Sets or replaces the username of any `userId`. No takeover by itself (signing in needs the password or passkey too), but a misused call renames a victim (impersonation, lockout of their old identifier) or squats names. |
| `deleteUsername`      | mutation |   🟠   | Deletes the username of any `userId`: the user can no longer be found by username (lockout of username sign-in), and the name is freed for someone else.                                                                   |
| `getUserIdByUsername` | query    |   🟢   | Lookup by public identifier, which is the first step of sign-in and needs no auth. Note: no rate limit, unlike `email.lookupEmail`, so usernames can be enumerated if the app exposes it directly.                         |
| `getUsername`         | query    |   🟡   | Username of any `userId`. Usernames are usually public, so low impact.                                                                                                                                                     |

### `authEmail`

| Function               | Kind     | Rating | Assessment                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------- | :----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookupEmail`          | mutation |   🟢   | Email → user id, rate-limited per client IP to prevent enumeration. Meant for unauthenticated callers.                                                                                                                                                                                                                                                                       |
| `getEmails`            | query    |   🟡   | All verified emails (PII) of any `userId`.                                                                                                                                                                                                                                                                                                                                   |
| `getPrimaryEmail`      | query    |   🟡   | Primary email (PII) of any `userId`.                                                                                                                                                                                                                                                                                                                                         |
| `deleteUser`           | mutation |   🟠   | Deletes all verified emails and pending challenges of any `userId`. Destructive and locks the user out of email-based recovery, but no takeover.                                                                                                                                                                                                                             |
| `signUp.check`         | mutation |   🟢   | Dry-run of `start`'s preconditions. Consumes the per-IP lookup limit on `EMAIL_TAKEN`.                                                                                                                                                                                                                                                                                       |
| `signUp.start`         | mutation |   🔴   | Binds the challenge to the given `userId`; `complete` then records the address on that user with no further user check. Throws if the user already has an email, but a user without one (e.g. a passkey- or OAuth-only user) can get an attacker's mailbox attached → takeover via any email-based sign-in or recovery. Also trusts `url` (the link base) and `emailSender`. |
| `signUp.complete`      | mutation |   🟢   | Needs the browser secret and the emailed code. Takes the user from the challenge row.                                                                                                                                                                                                                                                                                        |
| `addEmail.check`       | mutation |   🟢   | Same as `signUp.check`.                                                                                                                                                                                                                                                                                                                                                      |
| `addEmail.start`       | mutation |   🔴   | Binds the challenge to the given `userId`. An attacker who controls `userId` adds their own mailbox (they receive the link) to the victim → takeover via email sign-in or recovery. Also trusts `url` and `emailSender`.                                                                                                                                                     |
| `addEmail.complete`    | mutation |   🟢   | Needs the browser secret and the emailed code; `userId` must match the one given at start (`WRONG_USER` otherwise). Safe given a trustworthy `start`.                                                                                                                                                                                                                        |
| `changeEmail.check`    | mutation |   🟢   | Same as `signUp.check`.                                                                                                                                                                                                                                                                                                                                                      |
| `changeEmail.start`    | mutation |   🔴   | Same as `addEmail.start`, and on completion it also **removes** the victim's previous primary address.                                                                                                                                                                                                                                                                       |
| `changeEmail.complete` | mutation |   🟢   | Same as `addEmail.complete`.                                                                                                                                                                                                                                                                                                                                                 |
| `custom.check`         | mutation |   🟢   | Dry-run, no limit consumed.                                                                                                                                                                                                                                                                                                                                                  |
| `custom.start`         | mutation |   🟠   | Rate-limited, and proves mailbox control only; `complete` re-checks address ownership when `expectedUserId` is set. But `subject`, `intro` and `url` are trusted: if the app forwards client input, attackers send arbitrary content from the app's sender (phishing).                                                                                                       |
| `custom.peek`          | query    |   🟢   | Needs the browser secret and the code. Read-only.                                                                                                                                                                                                                                                                                                                            |
| `custom.complete`      | mutation |   🟢   | Needs the browser secret and the code; `currentUserId` must match `expectedUserId`, and the address must still belong to that user. What the app grants from `emailOwnerId` is its own responsibility.                                                                                                                                                                       |

### `authPasskey`

| Function                            | Kind     | Rating | Assessment                                                                                                                                                                                                                                         |
| ----------------------------------- | -------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startRegistrationForNewUser`       | mutation |   🟢   | Creates an unowned handle and a challenge. Only storage growth (cleaned up by TTL).                                                                                                                                                                |
| `startRegistrationForExistingUser`  | mutation |   🟠   | Trusts `verifiedUserId`: creates a handle for that user if missing and returns their credential ids (`excludeCredentials`). Harmless alone, but it is the first half of the 🔴 `finishRegistrationForExistingUser`.                                |
| `checkRegistrationForNewUser`       | query    |   🟢   | Query, so it cannot write. Verifies the attestation.                                                                                                                                                                                               |
| `finishRegistrationForNewUser`      | mutation |   🔴   | Verifies the WebAuthn attestation, but then attaches the passkey to whatever `newUserId` it gets. The only guard is "the user has no handle yet": an existing user without passkeys (e.g. a password user) gets the attacker's passkey → takeover. |
| `finishRegistrationForExistingUser` | mutation |   🔴   | Verifies the attestation and that `verifiedUserId` matches the one at start, but both come from the caller. An attacker who controls the `userId` of both calls registers their passkey on the victim → takeover.                                  |
| `startAuthentication`               | mutation |   🟢   | Creates a challenge. `userId` only narrows `allowCredentials` (and leaks that user's credential ids, which are not secret).                                                                                                                        |
| `finishAuthentication`              | mutation |   🟢   | Full WebAuthn assertion verification; the user comes from the credential. Caveat: `expectedRpId` and `expectedOrigin` are caller-provided and must be app constants, never client input.                                                           |
| `listPasskeys`                      | query    |   🟡   | Passkey metadata (names, credential ids) of any `userId`.                                                                                                                                                                                          |
| `deletePasskey`                     | mutation |   🟠   | Checks the passkey belongs to `userId`, but `userId` is trusted: deleting a victim's passkey locks them out. No takeover.                                                                                                                          |
| `renamePasskey`                     | mutation |   🟠   | Same check as `deletePasskey`; misuse renames a victim's passkey (low impact).                                                                                                                                                                     |
| `deleteUser`                        | mutation |   🟠   | Deletes every passkey and the handle of any `userId`. Destructive, lockout, no takeover.                                                                                                                                                           |

### `authTotp` (not exported yet)

| Function      | Kind     | Rating | Assessment                                                                                                                                                                                                                                               |
| ------------- | -------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTotp`  | mutation |   🔴   | Creates a pending secret for any `userId` and returns it. Together with `confirmTotp`, an attacker enrolls their authenticator on the victim and receives the backup codes, which defeats the second factor (and locks the user out if 2FA is enforced). |
| `confirmTotp` | mutation |   🔴   | Activates the pending secret of any `userId` given a valid code for it, and returns fresh backup codes. Safe only if `createTotp` was called for the right user — the code proves possession of the secret, not of the account.                          |
| `getStatus`   | query    |   🟡   | 2FA enabled flag and backup code count of any `userId`.                                                                                                                                                                                                  |
| `listTotps`   | query    |   🟡   | Active TOTP ids and creation times of any `userId`.                                                                                                                                                                                                      |

### `authAnonymous` (not exported yet)

| Function                 | Kind     | Rating | Assessment                                                                                                                                                                                   |
| ------------------------ | -------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAnonymousAccount` | mutation |   🔴   | Inserts an `anonymousId` → `userId` row with no check at all, **not even uniqueness** of `anonymousId` (unlike `oauth.createAccount`). Whoever holds that anonymous id signs in as `userId`. |

### `authOAuth`, `authGoogle`, `authApple`, `authGithub` (shared via `buildProviderFunctions`)

| Function                     | Kind     | Rating | Assessment                                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------- | :----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAuthorizationRequest` | mutation |   🟠   | Stores `stateHash`, `codeVerifier` and `redirectTo` as given. The component does **not** validate `redirectTo`: the method checks it against `allowedRedirectOrigins`, and a caller that skips that check gets an open redirect after sign-in. No takeover (the state is still bound to the caller). |
| `claimTicket`                | mutation |   🟢   | Needs the hash of the one-time ticket code and the hash of the original state; the payload is encrypted with a key derived from the raw code.                                                                                                                                                        |
| `getUserIdByAccount`         | query    |   🟢   | Provider account id → user id. Read-only; the danger is only in passing its result to `auth.signIn` without a verified provider account id.                                                                                                                                                          |
| `createAccount`              | mutation |   🔴   | Links any `providerAccountId` to any `userId` (rejects duplicates of `providerAccountId` only). An attacker who controls both links their own provider account to the victim, then signs in with the provider → takeover.                                                                            |

## Observations

- Every 🔴 function is meant to be called by the sign-in methods of this
  package, right after they verify the identity. None of them needs to be
  called by app code directly. Making them unreachable from the app (or
  requiring a proof, such as a short-lived token from the verifying
  component) would remove the whole class.
- `auth.signIn` is the root of trust. It could take a proof issued by the
  verifying component (e.g. the result of `password.verifyPassword`,
  `passkey.finishAuthentication`, `oauth.claimTicket` or an email `complete`)
  instead of a bare `userId`.
- The credential-binding functions could be split the same way: one for a
  brand new user created in the same mutation (checked against
  `createdUserIds`/a fresh-user token), and one for an existing user that
  requires a step-up proof.
- `anonymous.createAnonymousAccount` lacks the uniqueness check that
  `oauth.createAccount` has.
- `username.getUserIdByUsername` has no enumeration rate limit, unlike
  `email.lookupEmail`.
- `password.verifyPassword` throws on a `userId` with no password instead of
  returning a user error.
