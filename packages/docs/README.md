# CI-only folder

This folder is only for CI. Do not put documentation here. The documentation of
this branch is in `docs`.

The `auth-v2` Vercel project builds the v2 documentation. Its root directory is
`packages/docs`, which is where the v2 documentation is on the `main` branch.
Vercel also starts a preview deployment of this project for each pull request
into `v1`. If the root directory does not exist, the deployment fails.

The `vercel.json` file in this folder makes Vercel skip these deployments
(`"ignoreCommand": "exit 0"`). The `main` branch has the same file in `docs` for
the `convex-auth-docs` project.
