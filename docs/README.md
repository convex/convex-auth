# CI-only folder

This folder is only for CI. Do not put documentation here. The documentation
of this branch is in `packages/docs`.

The `convex-auth-docs` Vercel project builds the v1 documentation. Its root
directory is `docs`, which is where the v1 documentation is on the `v1`
branch. Vercel also starts a preview deployment of this project for each
pull request into `main`. If the root directory does not exist, the
deployment fails.

The `vercel.json` file in this folder makes Vercel skip these deployments
(`"ignoreCommand": "exit 0"`). The `v1` branch has the same file in
`packages/docs` for the `auth-v2` project.
