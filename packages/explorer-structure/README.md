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
- `inside.ts` reads the inside of a TypeScript module: its module doc comment,
  its exports, and where it keeps state.

**The project layer** says where things are and adds what only that project
has. Convex Auth's is `src/generate/convex-auth/layer.ts`:

- the program's files, and `@convex-dev/auth/...` resolved to `src/`,
- the component directories and the apps (the examples),
- the third parties (Google, Apple, GitHub, Discord, Resend, and the passkey
  authenticator, reached through `@simplewebauthn/browser`),
- the sign-in methods, their `setup…` functions and the app functions those
  return, the React hooks, the browser and SSR modules,
- the walks of the example frontends, down through the hooks,
- the places that report steps (`steps.ts`), and the stored keys and locks of
  the client modules (`holds.ts`).

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
  "modules": { "module:browser/retry": {/* ModuleInside */} },
  "steps": [/* StepSite */],
  "holds": { "module:browser/sessionManager": {/* ModuleHolds */} },
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

### Insides of modules

`modules` holds the inside of each `module` part, keyed by its id. It sits
beside `parts`, not in them, so that the parts, and the layout that follows
them, stay the same when only the inside of a module changes. The generic
layer defines it (`ModuleInside` in `src/model.ts`); a project layer fills it
for the modules it has.

```jsonc
"module:browser/retry": {
  "file": "packages/core/src/browser/retry.ts",
  "summary": "Retry policy for the client's auth calls (session refresh, OAuth code redemption).",
  "description": "Retry policy for the client's auth calls (…). …",
  "exports": [
    { "name": "retryOnNetworkError", "kind": "function", "line": 30, "summary": "…" }
  ],
  "state": []
}
```

- `summary` and `description` are the first sentence and the first paragraph
  of the file's module doc comment, copied from the source. The lines of the
  paragraph are joined with spaces and `{@link X}` is written `X`; nothing
  else changes. A file without one has neither field. The module doc comment
  is the first `/** … */` before the first statement when it carries
  `@module`, when another doc comment follows it, or when the statement is an
  import; else it documents that statement.
- `exports`, in the order of the file: `name`, `kind` (`function`, `class`,
  `const`, `let`, `interface`, `type`, `enum`, `namespace`, `default`, or
  `all` for an `export *`, named `*`), the `line`, and the first sentence of
  its own doc comment (`summary`). A `const` whose value is a function is a
  `function`. A re-export says where it `from`: a module part's id, else a
  file of the repository, else the package. An export that is a part (a React
  hook) carries the part's id in `part`, so the hook is described once, as a
  part. A class carries its public `members` (methods, fields, and
  accessors).
- `state`: a top-level `let` or `var`, a `Map`, `Set`, `WeakMap`, or `WeakSet`
  a top-level `const` holds (not a `Readonly…` one), and the fields of its
  classes, private ones included, but not a field that holds a function.
  Names only, never a value.

### Step sites

`steps` lists every call of Convex Auth's step reporters (`StepSite` in
`src/convex-auth/model.ts`): `reportClientStep` (`packages/core/src/browser/steps.ts`)
and `reportStep` (`packages/core/src/lib/steps.ts`). The scan
(`src/generate/convex-auth/steps.ts`) takes the reporters as data, the
function and the positions of its arguments, so another project passes its
own.

```jsonc
{
  "step": "lock.acquired",
  "runsIn": "browser",
  "location": {
    "file": "packages/core/src/browser/sessionManager.ts",
    "line": 544,
  },
  "part": "module:browser/sessionManager",
  "export": "AuthClient",
  "within": ["AuthClient", "fetchAccessToken"],
  "reportsAs": "module:browser/mutex",
  "detailKeys": ["lock", "namespace"],
}
```

- `step`: the name the report carries. It must be spelled out in the source
  (a literal or a constant of a literal type); the generator throws when it
  is not.
- `part`: the part whose code holds the call: the module of a client file; on
  the server the method function or the setup function around it; `null` in
  `lib/steps.ts`, which no part holds.
- `export`: the top-level export around the call. A call in code the file
  does not export has `null`, and `reachedFrom`: the exports whose code
  refers to that code, within the file.
- `within`: the named functions and classes around the call, outermost
  first.
- `reportsAs`: the part the report names in its `part` field, when the source
  spells it out. It is not always `part`: `browser/sessionManager` reports
  the `lock.*` steps as `module:browser/mutex`. When the part is a parameter,
  `reportsAsPassedIn` names it and lists the value each caller passes
  (`react/signInSteps` gets `module:react/index` and
  `module:ssr/nextjs/client`). A server report names no part: it belongs to
  the run of the function that wrote it.
- `detailKeys`: the names of the detail's keys, read from the object literal
  and the types of its spreads. `detailOpen` lists the spreads whose type
  does not tell its keys (`outcomeOf(result)`).
- `detailLiterals`: the detail values the call writes as literals in the
  source (a string, a number, or a boolean), by key, such as
  `{ "via": "signUp" }`. They are source text, not values the code computes;
  a computed value stays a name in `detailKeys`.

### What client modules hold

`holds`, keyed by module part id, has what a module holds where the source
says it plainly (`src/generate/convex-auth/holds.ts`):

- `storage`: the logical keys it reads and writes through a
  `NamespacedStorage` (which ends the stored key with `_<namespace>`) or a
  `SignInStorage` (which starts it with the sign-in's id), with the methods
  (`get`, `set`, `remove`, `key`) and the evidence. A key counts when the
  source spells it out: a literal, a constant, or a property of a constant
  object (an index with a variable counts for each key of the object).
  `unresolvedStorage` has the calls whose key it does not.
- `locks`: each `runWithMutex` call, with the stored key it is named after
  when the source shows it (`this.#lockKey`, set once from
  `storage.key(REFRESH_TOKEN_STORAGE_KEY)`).

What the model cannot tell: the value of anything at run time, the keys a
caller of `NamespacedStorage` passes in a variable, the keys of a detail
built by a function that returns a `Record` (`outcomeOf`), and state held in
closures (a hook's `useState`, a variable a function captures).

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

`stepOrigin(model, step)` maps a recorded step (a line whose `kind` is
`step`) to the sites that can have reported it, and the part and the export
they share:

```ts
import { stepOrigin, structure } from "@convex-dev/explorer-structure";

stepOrigin(structure, {
  runsIn: "browser",
  part: "module:browser/mutex",
  step: "lock.acquired",
});
// { part: "module:browser/sessionManager", export: "AuthClient", sites: [ … ] }
stepOrigin(structure, { step: "refresh.result" }); // a server step
// { part: "methodFn:core.refreshSession", export: "setupConvexAuth", sites: [ … ] }
```

A client step matches by its name and the part it reports as; a server step
by its name alone. When several sites match, those whose detail keys cannot
hold the recorded ones are dropped, then those that write a literal the
recorded detail does not hold: `via` tells the `session.issued` of a sign-up
from that of a sign-in, `scope` the two `sessions.revoked`, and `initial` the
first `state` from the later ones. One recorded step still has two sites:
`signOut.revoke` with `skipped: false`, which the SSR branch of
`AuthClient`'s constructor writes as a literal and the SPA branch computes
(`refreshToken === null`), so the step alone cannot tell them apart; the
page's `init` step, whose `mode` is `spa` or `ssr`, can. `stepSites` lists
both. A test maps every step of the world's recordings.

## What it does not model yet

- Cron jobs. No component or app here has a `crons.ts`; the generator throws
  when one appears, so the model never misses one silently.
- When two apps mount the same npm component at different versions (Resend
  0.2.6 and 0.2.8 here), the first app read gives its parts.
- A redirect of the browser to a provider's authorization endpoint is not a
  `fetch`, so it is not a dependency.
