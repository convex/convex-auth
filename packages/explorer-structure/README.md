# @convex-dev/explorer-structure

The structure model of Convex Auth: every part of the system and every
dependency between parts, as one JSON file, `structure.json`. The 3D explorer
lays its world out from it.

The model is generated from the source, never edited by hand:

```sh
pnpm --filter @convex-dev/explorer-structure generate  # rewrite structure.json
pnpm check:structure                                    # fail if it is stale
```

The generator reads:

- each `convex.config.ts`, for the components, their child components, their
  env vars, and what each example app mounts,
- each `schema.ts`, for the tables, through the types of their validators,
- each `_generated/api` file, for the modules of a component or an app, whose
  exports the type checker classifies as queries, mutations, actions, or HTTP
  actions,
- the source, for the call sites.

It builds one TypeScript program over `packages/core/src` and the example apps,
with `@convex-dev/auth/...` resolved to the source rather than `dist/`, and
follows calls through the type checker and a small evaluator (see
`src/generate/analyzer.ts`). A dependency it cannot resolve goes to
`unresolved`, with the reason. It never guesses.

## Format

The types are in `src/model.ts`. Import them, and the model, from the package:

```ts
import { structure, type Part } from "@convex-dev/explorer-structure";
```

```jsonc
{
  "version": 1,
  "parts": [/* Part */],
  "dependencies": [/* Dependency */],
  "unresolved": [/* Unresolved */],
  "counts": { "parts": {}, "dependencies": {}, "unresolved": {} },
}
```

Every location is `{ "file", "line" }`: a path from the repository root and a
1-based line. A file of an npm package is named by the package and its
version, for example `@convex-dev/resend@<version>/dist/component/lib.js`.

### Parts

Each part has an `id`, a `kind`, a `name`, the id of its `parent` (`null` at
the top), and the `source` it is defined at. Ids are built from names, never
from lines, so they stay stable as the code moves.

| kind              | id                                                                            | parent                                                                     |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `region`          | `region:browser`, `region:ssr`, `region:app`                                  | —                                                                          |
| `component`       | `component:auth`, `component:authEmail/rateLimiter`, `component:resend`       | — (child components: their parent; app-level npm components: `region:app`) |
| `thirdParty`      | `thirdParty:google`, `thirdParty:passkeyAuthenticator`, …                     | —                                                                          |
| `table`           | `table:auth.sessions`, `table:app:<example>.users`                            | its component or example app                                               |
| `function`        | `fn:auth:public.refresh`, `fn:app:<example>:auth.signOut`                     | its component or example app                                               |
| `function` (HTTP) | `httpAction:authGoogle:/callback`                                             | its component                                                              |
| `httpRoute`       | `route:authGoogle:GET /callback`                                              | its component                                                              |
| `envVar`          | `env:authGoogle.CLIENT_ID`, `env:app:<example>.SITE_URL`                      | its component or example app                                               |
| `method`          | `method:username-password`                                                    | —                                                                          |
| `setupFunction`   | `setup:username-password.setupUsernamePassword`, `setup:core.setupConvexAuth` | its method, or `region:app`                                                |
| `methodFunction`  | `methodFn:username-password.signInWithUsernamePassword`                       | its setup function                                                         |
| `module`          | `module:browser/sessionManager`                                               | its method, or its region                                                  |
| `hook`            | `hook:methods/username-password/react.useSignInWithUsernamePassword`          | its module                                                                 |
| `exampleApp`      | `example:react-username-password`                                             | `region:app`                                                               |

A function's `module` is its path in `api.<module>.<name>`, with `/` between
directories. A route's `path` is relative to the `httpPrefix` the app mounts
the component under. A module and a hook carry `runsIn`: `browser` or `ssr`
(an `ssr/` file marked `"use client"` runs in the browser).

A method function is the library's definition. An example app's function that
a method returns is a separate part, `fn:app:…`, with a `definedBy` dependency
on the method function.

### Dependencies

Each dependency has a `kind`, `from` and `to` part ids, and `evidence`: every
place in the source that shows it. `via` names how, where it varies: the `ctx`
method of a call, the `ctx.db` methods of a table access, the client function
of a child component, the host of a fetch.

| kind                  | from → to                                            | shown by                                                          |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `calls`               | function → function                                  | `ctx.runQuery` / `runMutation` / `runAction`                      |
| `schedules`           | function → function                                  | `ctx.scheduler.runAfter` / `runAt`                                |
| `reads`, `writes`     | function → table                                     | `ctx.db.get` / `query`; `insert` / `patch` / `replace` / `delete` |
| `usesComponent`       | component → child component                          | `component.use`                                                   |
| `callsChildComponent` | function → child component                           | its client library (`rateLimiter.limit`, `ping`)                  |
| `clientCalls`         | hook, module, or example app → app function          | `useQuery`, `signInApi.mutation`, …                               |
| `routesTo`            | HTTP route → HTTP action                             | `http.route`                                                      |
| `fetches`             | function or component → third party                  | `fetch` of a URL the code spells out                              |
| `webauthn`            | hook, module, or example app → passkey authenticator | `@simplewebauthn/browser`                                         |
| `referencesFunction`  | → function                                           | a reference passed on rather than called                          |
| `readsEnv`            | function → env var                                   | `env.NAME`                                                        |
| `mounts`              | example app → component                              | `app.use`                                                         |
| `usesMethod`          | example app → method or core setup                   | a call of its `setup…` function                                   |
| `definedBy`           | example app function → method function               | the property the app destructures                                 |
| `imports`             | module → module                                      | an `import`                                                       |

The walks that start from an example app pass its arguments through the
library: a hook's function references, a method's components. A dependency
that holds only there carries `example`, the example app it was resolved in.
The same call site walked from the library alone resolves through the types
where it can (a `ComponentApi` property names its component function).

### Unresolved

Each entry has a `kind` (`call`, `functionReference`, `clientCall`, `table`,
`fetch`, `httpRoute`), the `location` and `code` of the site, the `reason`,
and `from`: the parts whose walks reached it. A site that any walk resolves is
not listed. Most entries are function handles, references a library hook
forwards from its caller, members of interfaces with more than one
implementation (`TokenStorage`), and URLs built from configuration.

## What it does not model yet

- Cron jobs. No component or example has a `crons.ts`; the generator throws
  when one appears, so the model never misses one silently.
- The functions inside child components from npm (`rateLimiter`,
  `batchWorker`, `resend`) are listed from the `ComponentApi` types their
  parents see, without their own tables or calls.
- A redirect of the browser to a provider's authorization endpoint is not a
  `fetch`, so it is not a dependency.
