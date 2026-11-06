# Codegen host

An empty Convex app that exists only so that `pnpm codegen` has a deployment to
generate code against. Every app and every component generates its code
against the anonymous local deployment of this directory, never against the
deployment that an example selects, thus an example can point at any
deployment without breaking codegen.

`scripts/codegen.ts` runs `convex dev --once` here, with
`scripts/codegenTasks.ts` as its `--start` command. The CLI keeps the local
backend up while that command runs, and stops it once the command exits or on a
Ctrl-C.

It is a workspace package, thus `pnpm install` links the `convex` that it
declares. `scripts/codegen.ts` finds it like any other app and leaves it out of
the app list, because it generates no code of its own.
