# Codex exploration of Auth v2 component configuration

**DO NOT REVIEW. This is a Codex exploration, not a proposed implementation or a change intended to merge.**

This probe explores moving Convex Auth v2 callback registration and static
settings into component configuration using the `reece/component-args` prototype
at `627690e3`. It targets the Convex JS API, assuming the server implementation
of init works correctly. The preview dependency is pinned in this directory's
`package.json`; production Auth dependencies and code are unchanged.

The API can express nested callback references and installation-time settings.
The two main application-facing questions are preserving app user ID and profile
typing across the component boundary, and deciding whether custom OAuth profile
mappers should remain ordinary app-side functions or become Convex functions.
Moving configuration alone does not require changing browser APIs or migrating
authentication records, provided component paths and identity contracts stay
stable.

## Run the probe

Use Node 22.6 or newer. This directory deliberately sits outside the pnpm
workspace package globs so the preview does not affect normal builds.

```sh
cd explorations/component-args
npm ci --ignore-scripts
npm test
```

`typecheck.ts` checks accepted callback assignments and expected compiler errors.
`runtime.ts` asserts validator and nested-reference serialization and rejection
of env references in init arguments. Its casts expose SDK analysis internals for
the harness; they are not proposed application code.

This is not an end-to-end Auth rewrite: it does not deploy, run init against a
backend, invoke stored handles, regenerate a deployed app's API, or exercise a
populated deployment upgrade. Migration conclusions below are design analysis,
not a demonstrated migration.

## What the SDK probe establishes

| Case                                                                                  | Result                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Callback references inside provider objects inside arrays                             | Serialize as nested references.                                        |
| A create-user mutation returning `Id<"users">` against a string return contract       | Accepted.                                                              |
| A create-user mutation returning `Id<"orders">` against the same contract             | Also accepted; the table constraint is lost.                           |
| A sign-in callback requiring `Id<"users">` against an opaque string argument contract | Rejected.                                                              |
| Callback requiring an extra argument the component will not pass                      | Rejected.                                                              |
| Query supplied where a mutation is required                                           | Rejected.                                                              |
| Number return supplied where a string is required                                     | Rejected.                                                              |
| Narrow profile callback against `profile: v.any()`                                    | Accepted; this does not preserve provider profile checks.              |
| Generic-only `v.function<...>()`                                                      | Serializes as `{ type: "function" }`; the generic signature is erased. |
| `v.function({ fnType, args, returns })`                                               | Serializes the signature for codegen.                                  |
| Env reference supplied as an init argument                                            | Rejected by the SDK serializer.                                        |

The preview's `src/values/validators.ts` documents function signatures as
advisory: a validator cannot reach the function named by a handle to check its
signature. TypeScript compatibility checks should not be mistaken for runtime
signature verification. Invoked functions still have their own validators.
The preview's `src/cli/codegen_templates/validator_helpers.ts` reconstructs
function handle types from serialized signatures; generic-only signatures do not
survive that route.

## App user IDs and provider profiles

The app owns its users table. The core stores the returned identifier as
`v.string()` in its [accounts and sessions schema](../../packages/core/src/component/schema.ts).
This is a namespace issue as well as a table-name issue: `v.id("users")` inside
the Auth component would describe a table in that component's namespace, not the
app's table. Runtime validation of app IDs belongs to app-side functions.

Today, [setupConvexAuth](../../packages/core/src/server/setup.ts) carries the
configured users-table name into [UserCallbacks](../../packages/core/src/lib/types.ts).
The method setup helper supplies the provider name and profile type. Together
these check that `createUser` accepts the provider payload and returns an ID from
the configured app table, and that `onSignIn` accepts that payload and user ID.
The core rebrands its stored string internally when invoking those callbacks.

A component contract promising to pass an arbitrary string cannot safely accept
a callback requiring `Id<"users">`. Conversely, a string return contract accepts
IDs from any app table. Replacing profiles with `v.any()` similarly drops the
existing profile compatibility checks.

This appears solvable with an app-facing typed configuration helper or adapter
that preserves the existing provider/profile/users-table relationship and
bridges to opaque IDs inside the library. Such a helper is not implemented by
this probe. Applications should not have to weaken existing `v.id(...)` callback
validators or add casts themselves. Bundled providers can use precise profile
validators; custom profiles need an explicit typing design.

## Custom OAuth profile mapping

The current [OAuth catalog](../../packages/core/src/methods/oauth/server.ts)
accepts an ordinary synchronous JS function that maps claims and userinfo
responses into an account profile. That closure cannot be serialized as a
component argument: `v.function()` represents a registered Convex function
handle, not arbitrary JavaScript code.

There are two choices:

- Keep mapping in the app-side sign-in method. The mapper can remain unchanged
  while serializable settings and callback references move to configuration.
- Move invocation into a component. The mapper must become a registered Convex
  function, for example an internal query, with a function reference and an
  input/output contract. Captured values need runtime env access or explicit
  inputs. Keeping a query or mutation call inside the sign-in mutation can retain
  transactional behavior; moving the flow into actions would change it.

Adopting component configuration does not require adopting the second choice.

## Expected application changes

Callbacks and static settings would move from `auth.ts` into `convex.config.ts`.
Thin app-side public functions would remain. Existing `createUser` and
`onSignIn` mutation implementations can stay unchanged if the configuration API
preserves their typed contracts and payloads.

Secrets and env-derived values cannot simply move into init args. Existing env
bindings can remain; email delivery could alternatively use an app-side callback
that reads credentials at runtime. Custom OAuth JS mappers require changes only
if their invocation moves into components.

React hooks, browser storage, SSR integration, and public endpoint contracts do
not inherently need changes. Preserve app-level identity checks: the current
`isAuthenticated` implementation deliberately reads verified `ctx.auth` in the
app, and authenticated email/passkey management similarly needs trusted app-side
identity handling.

## Compatibility and stored data

Adding a configuration table does not itself require rewriting accounts,
sessions, refresh-token hashes, password hashes, usernames, verified emails,
passkey credentials, or TOTP secrets. Compatibility depends on these conditions:

- Keep storage components at their existing mount paths. Nesting an existing
  provider under a new parent changes the component owning its database; records
  do not automatically follow. New orchestration can reference existing storage
  components instead.
- Preserve provider names and account-ID conventions. Account lookups are keyed
  by provider name and provider account ID; names such as `password` and
  `emailPassword` are distinct identities, not interchangeable display labels.
- Preserve signing material, JWT subject, audience, and issuer. The current
  [core implementation](../../packages/core/src/component/public.ts) receives the
  bare app issuer because its component `CONVEX_SITE_URL` includes the HTTP
  prefix. Reading that value directly would change the issuer.
- Preserve public endpoint paths, function kinds, payloads, and response
  envelopes so existing clients and SSR handlers keep working.
- Continue understanding stored email challenges, OAuth requests/tickets, and
  passkey ceremonies until they complete or expire. Configuration changes must
  preserve the intended split between settings captured at start and settings
  read at completion.
- Keep `createUser` once per new account and `onSignIn` on every sign-in, including
  the first. A rejecting hook must continue to roll back transactional work.
- Update persisted configuration on each push without modifying identity data.
  Omitting a previously configured optional hook must remove it; patching only
  supplied fields can leave stale hooks active.

An additive rollout could make init args optional, support existing runtime
callbacks alongside configured callbacks with explicit precedence, and migrate
setup helpers separately. Requiring configuration immediately would be a source
break, even if stored data and existing sessions remain compatible.

## New concerns versus existing constraints

| Concern                                               | Relationship to the refactor                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| App ID and profile typing at configuration boundaries | New bridge needed to preserve today's checks.                                                           |
| Callback registration separated from exported methods | New mismatch risk; mounting unused components is already possible today.                                |
| Static settings and runtime env access                | Existing distinction made more visible by init restrictions.                                            |
| Thin app-side public wrappers                         | Existing requirement; avoid new duplication between wrappers and configuration.                         |
| Credential stores shared by multiple sign-in methods  | Existing useful separation; preserve it rather than putting all method settings on a storage component. |
| Changing configuration during an in-flight flow       | Existing deployment concern; retain current semantics.                                                  |
| Removing a provider while retaining accounts/sessions | Existing policy question; removing stale persisted configuration is new.                                |
| Tests needing persisted configuration                 | New setup requirement; current component registration helpers only register modules and schema.         |

The least disruptive next step would be typed function validators and optional
configuration on the existing component mounts, retaining app-side methods and
client contracts. Moving method orchestration into components can then be
evaluated separately.
