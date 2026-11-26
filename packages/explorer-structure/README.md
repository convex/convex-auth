# @convex-dev/explorer-structure

The structure model of a Convex project: every part of the system and every
dependency between parts, as one JSON file. The 3D explorer lays its world out
from it. `structure.json` is the model of Convex Auth.

The model is generated from the source, never edited by hand:

```sh
pnpm --filter @convex-dev/explorer-structure generate  # rewrite structure.json
pnpm check:structure                                    # fail if it is stale
```

## Two layers

The generator has two layers, so it can map other codebases.

**The generic layer**, `src/generate/convex/`, reads any Convex project. It
knows Convex, not a repository:

- `program.ts` builds one TypeScript program over the files a project names,
  with the import mappings it passes (a workspace package to its source, a
  tsconfig `paths` alias).
- `project.ts` (`ConvexProject`) reads each `convex.config.ts` (components,
  child components, env vars, what each app mounts), each `schema.ts` (tables,
  with field types from their validators, and indexes), and each
  `_generated/api` file (the modules, whose exports the type checker classifies
  as queries, mutations, actions, or HTTP actions). It walks every function, the
  HTTP routers, and the compiled code of components from npm.
- `analyzer.ts` follows calls through the type checker and a small evaluator
  that carries arguments into the functions it walks. It records calls,
  scheduled functions, table reads and writes, env reads, fetches, calls into
  child components and third-party libraries, and client calls of function
  references.

**The project layer** says where things are and adds what only that project
has. Convex Auth's is `src/generate/convex-auth/layer.ts`:

- the program's files, and `@convex-dev/auth/...` resolved to `src/`,
- the component directories and the apps (the examples),
- the third parties (Google, Apple, GitHub, Discord, Resend, and the passkey
  authenticator, reached through `@simplewebauthn/browser`),
- the sign-in methods, their `setup…` functions and the app functions those
  return, the React hooks, the browser and SSR modules,
- the walks of the example frontends, down through the hooks.

The generic layer runs on its own, with no project layer, on any Convex
project:

```sh
tsx src/generate/convex/cli.ts <repository root> <convex dir>... [--frontends] [--types=node,vite/client]
```

or `buildConvexModel` from `src/generate/convex/index.ts`. A test runs it on
`examples/react-username-password` alone: the auth components arrive the way a
published `@convex-dev/auth` ships them.

Components come from source wherever it exists: the project's own, and an npm
package's when it ships `src/<dir>` beside `dist/<dir>` with its `_generated`
files (`@convex-dev/rate-limiter`, `batch-worker`, `workpool`, `resend`, and
`@convex-dev/auth` all do). Each instance gets its own parts, so the rate
limiter of `authPassword` and the one of `authEmail` each have their table and
their functions. A package that ships no source contributes its functions from
the `ComponentApi` type its parent sees, and the `fetch` calls of its compiled
code.

A layer for another project creates a `ConvexProject` with its own
`ProjectOptions`, adds its parts with `addPart` and its dependencies with
`addDependency`, calls `walkFunctions`, `walkHttpRouters`, and
`scanPackageFetches`, and returns `model(projectName, kinds)`, where `kinds`
labels each part and dependency kind the layer adds. Its part and
dependency types extend the generic ones through the type parameters of
`StructureModel`, as `src/convex-auth/model.ts` does.

Nothing in the generic layer may name this repository; a test checks it. A
dependency the analysis cannot resolve goes to `unresolved`, with the reason.
It never guesses.

## Format

The generic types are in `src/model.ts`, Convex Auth's in
`src/convex-auth/model.ts`. Import them, and the model, from the package:

```ts
import {
  structure,
  type ConvexAuthStructure,
} from "@convex-dev/explorer-structure";
```

```jsonc
{
  "version": 3,
  "project": "convex-auth",
  "kinds": {
    "parts": { "table": { "layer": "convex", "label": "Table", "description": "…" }, "method": { "layer": "convex-auth", … } },
    "dependencies": { … }
  },
  "parts": [/* Part */],
  "dependencies": [/* Dependency */],
  "unresolved": [/* Unresolved */],
  "counts": { "parts": {}, "dependencies": {}, "unresolved": {} },
}
```

`kinds` lists every kind the model uses, with the layer that defines it and a
label, so a reader that knows only the generic kinds can still draw the rest.

Every location is `{ "file", "line" }`: a path from the repository root and a
1-based line. A file of an npm package is named by the package and its
version, for example `@convex-dev/resend@<version>/dist/component/lib.js`.

### Parts

Each part has an `id`, a `kind`, a `name`, the id of its `parent` (`null` at
the top), and the `source` it is defined at. Ids are built from names, never
from lines, so they stay stable as the code moves.

Generic parts:

| kind                     | id                                                                      | parent                         |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------ |
| `region`                 | `region:app` (a project adds its own, e.g. `region:browser`)            | —                              |
| `app`                    | `app:<name>`                                                            | `region:app`                   |
| `component`              | `component:auth`, `component:authEmail/rateLimiter`, `component:resend` | —, its parent, or `region:app` |
| `thirdParty`             | `thirdParty:google`, …                                                  | —                              |
| `table`                  | `table:auth.sessions`, `table:app:<name>.users`                         | its component or app           |
| `function`               | `fn:auth:public.refresh`, `fn:app:<name>:auth.signOut`                  | its component or app           |
| `function` (HTTP action) | `httpAction:authGoogle:/callback`                                       | its component                  |
| `httpRoute`              | `route:authGoogle:GET /callback`                                        | its component                  |
| `envVar`                 | `env:authGoogle.CLIENT_ID`, `env:app:<name>.SITE_URL`                   | its component or app           |

Convex Auth parts:

| kind             | id                                                                            | parent                      |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------- |
| `method`         | `method:username-password`                                                    | —                           |
| `setupFunction`  | `setup:username-password.setupUsernamePassword`, `setup:core.setupConvexAuth` | its method, or `region:app` |
| `methodFunction` | `methodFn:username-password.signInWithUsernamePassword`                       | its setup function          |
| `module`         | `module:browser/sessionManager`                                               | its method, or its region   |
| `hook`           | `hook:methods/username-password/react.useSignInWithUsernamePassword`          | its module                  |

A function's `module` is its path in `api.<module>.<name>`, with `/` between
directories. A route's `path` is relative to the `httpPrefix` the app mounts
the component under. A module and a hook carry `runsIn`: `browser` or `ssr`
(an `ssr/` file marked `"use client"` runs in the browser).

A method function is the library's definition. An app's function that a
method returns is a separate part, `fn:app:…`, with a `definedBy` dependency
on the method function.

### Dependencies

Each dependency has a `kind`, `from` and `to` part ids, and `evidence`: every
place in the source that shows it. `via` names how, where it varies: the `ctx`
method of a call, the `ctx.db` methods of a table access, the library function
of a child component or third party, the host of a fetch.

Generic kinds:

| kind                  | from → to                           | shown by                                                          |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `calls`               | function → function                 | `ctx.runQuery` / `runMutation` / `runAction`                      |
| `schedules`           | function → function                 | `ctx.scheduler.runAfter` / `runAt`                                |
| `reads`, `writes`     | function → table                    | `ctx.db.get` / `query`; `insert` / `patch` / `replace` / `delete` |
| `usesComponent`       | component → child component         | `component.use`                                                   |
| `mounts`              | app → component                     | `app.use`                                                         |
| `callsChildComponent` | function → child component          | its client library (`rateLimiter.limit`, `ping`)                  |
| `referencesFunction`  | → function                          | a reference passed on rather than called                          |
| `readsEnv`            | function → env var                  | `env.NAME`                                                        |
| `routesTo`            | HTTP route → HTTP action            | `http.route`                                                      |
| `fetches`             | function or component → third party | `fetch` of a URL the code spells out                              |
| `callsThirdParty`     | → third party                       | a call into a library the project names for it                    |
| `clientCalls`         | client code → app function          | `useQuery`, `client.mutation`, …                                  |

Convex Auth kinds:

| kind         | from → to                         | shown by                          |
| ------------ | --------------------------------- | --------------------------------- |
| `usesMethod` | app → method, or the core's setup | a call of its `setup…` function   |
| `definedBy`  | app function → method function    | the property the app destructures |
| `imports`    | module → module                   | an `import`                       |

A walk that starts from an app passes that app's arguments through the
library code it calls: a hook's function references, a method's components. A
dependency that holds only there carries `app`, the app it was resolved in.
The same call site walked from the library alone resolves through the types
where it can (a `ComponentApi` property names its component function).

### Unresolved

Each entry has a `kind` (`call`, `functionReference`, `clientCall`, `table`,
`fetch`, `httpRoute`), the `location` and `code` of the site, the `reason`,
and `from`: the parts whose walks reached it. A site that any walk resolves is
not listed. Most entries are function handles, references a library hook
forwards from its caller, members of interfaces with more than one
implementation (`TokenStorage`), and URLs built from configuration.

## Joining a recording

`joinRecording(model, appName)` maps what a recording of an app holds to part
ids:

```ts
import { joinRecording, structure } from "@convex-dev/explorer-structure";

const join = joinRecording(structure, "react-username-password");
join.run({ componentPath: "", identifier: "auth:signUpWithUsernamePassword" });
// "fn:app:react-username-password:auth.signUpWithUsernamePassword"
join.run({ componentPath: "auth", identifier: "sessions:deleteSessionTokens" });
// "fn:auth:sessions.deleteSessionTokens"
join.callTarget("authUsername/public/getUserIdByUsername");
// "fn:authUsername:public.getUserIdByUsername"
join.table({ component: "authPassword/rateLimiter", table: "rateLimits" });
// "table:authPassword/rateLimiter.rateLimits"
```

It reads the instance names from the app's `mounts` dependencies (`via`). A
run of an app function maps to the app's function part, `fn:app:<app>:…`, not
to the method function the library defines; follow its `definedBy` dependency
to that. A name it cannot find gives `null`. A test maps every run, call
target, and table of the recorder's fixture recording.

## What it does not model yet

- Cron jobs. No component or app here has a `crons.ts`; the generator throws
  when one appears, so the model never misses one silently.
- When two apps mount the same npm component at different versions (Resend
  0.2.6 and 0.2.8 here), the first app read gives its parts.
- A redirect of the browser to a provider's authorization endpoint is not a
  `fetch`, so it is not a dependency.
