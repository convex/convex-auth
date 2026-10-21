# Doc examples

The app that the code examples in the doc comments of `@convex-dev/auth`
compile against. It is not an example to copy: it installs every component
and sets up every sign-in method, because the examples use all of them.

`pnpm check:doc-examples` (`scripts/checkDocExamples.ts`) puts each example
in this app and typechecks it:

- A `tsx` example goes in `src/`, an example from `packages/core/src/ssr/` in
  `app/`, and any other example in `convex/`. Thus
  `../convex/_generated/api`, `./_generated/server`, and `@/auth` resolve to
  the files of this app.
- An example can use a name that it does not import, for example `api`,
  `components`, `internal`, `query`, or a function of `@convex-dev/auth`.
  The script imports it.

When an example uses a function or a component that this app does not have,
add it here, then run `pnpm codegen doc-examples`.
