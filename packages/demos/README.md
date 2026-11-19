# demos

This private package deploys the live demos of Convex Auth. Each demo is one
example of `examples/`, served at `https://<name>.demos.convex-auth.com`.
The list of demos is in [`src/demos.ts`](src/demos.ts).

The `Deploy demos` workflow (`.github/workflows/deploy-demos.yml`) runs it on
each push to `main`.

## How it works

All the demos are in one Convex project (`convex-auth-demos`), in a team that
holds only the demos. Each demo has its own prod deployment, whose
`reference` is the name of the demo. For each demo, `pnpm --filter demos run
deploy`:

1. Creates the project and the deployment if they do not exist. A new
   deployment gets the default environment variables of the project.
2. Registers `<name>.demos.convex-auth.com` as a custom domain for the HTTP
   actions of the deployment. When Convex verified its DNS records, the
   script makes it the `CONVEX_SITE_URL` of the deployment. Until then, the
   script shows a warning, and the demo is served at the `.convex.site` URL of
   the deployment.
3. Sets `SITE_URL` to the origin of the demo, and `RP_ID` to its domain. The
   examples read `SITE_URL` for the links in their emails, the allowed OAuth
   redirect origin, and the origin of the passkeys. The passkey examples read
   `RP_ID` for the domain of the passkeys.
4. Adds the
   [static hosting component](https://www.convex.dev/components/static-hosting)
   to `convex/convex.config.ts` of the example, at `/`. Then it builds the
   frontend, pushes the functions, and uploads the frontend. At the end, it
   puts back the files of the example. The examples are code for the readers
   of the docs, thus they do not contain this change.

A deploy key exists only during the deploy of its demo. If a demo fails, the
script deploys the other demos and then fails.

The script does not delete a deployment whose demo is not in `src/demos.ts`,
because that also deletes its data. It shows a warning instead.

## Setup

Do these steps one time.

1. Create a Convex team for the demos, with a Pro plan (custom domains need
   it).
2. Create a team access token. In the settings of the GitHub repository, in
   the `demos` environment, add it as the `CONVEX_DEMOS_ACCESS_TOKEN` secret,
   and add the ID of the team as the `CONVEX_DEMOS_TEAM_ID` variable. Do not
   add them to the repository: a workflow on any branch can read the secrets
   of the repository. The `demos` environment accepts only the `main` branch.
3. Run the workflow once (or wait for a push to `main`). It creates the project
   and the deployments. The demos that need secrets fail until step 4.
4. In the settings of the project, add the secrets as default environment
   variables for **prod** deployments. Select "apply to existing
   deployments". All the demos get all the secrets.

   | Demo               | Environment variables                                                                       |
   | ------------------ | ------------------------------------------------------------------------------------------- |
   | `email-password`   | `RESEND_API_KEY`, `SENDER_EMAIL`, optionally `SENDER_NAME`                                  |
   | `email-magic-link` | `RESEND_API_KEY`, `SENDER_EMAIL`, optionally `SENDER_NAME`                                  |
   | `google`           | `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`                                        |
   | `apple`            | `AUTH_APPLE_CLIENT_ID`, `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`, `AUTH_APPLE_PRIVATE_KEY` |
   | `github`           | `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`                                        |
   | `discord`          | `AUTH_DISCORD_CLIENT_ID`, `AUTH_DISCORD_CLIENT_SECRET`                                      |

   `SENDER_EMAIL` must be on a domain that you verified with Resend.

5. For each demo, add the DNS records of its domain that the Convex dashboard
   shows (in the settings of the deployment). The workflow shows a warning for
   each domain that Convex did not verify.
6. For each OAuth demo, create the OAuth app with this redirect URI:
   `https://<name>.demos.convex-auth.com/oauth/<name>/callback` (for example
   `https://github.demos.convex-auth.com/oauth/github/callback`). This URI
   works only after Convex verified the domain and the workflow ran again.

## Add a demo

1. Add the demo to `src/demos.ts`. The example must not have a
   `convex/http.ts`, because the static hosting component takes `/`. If the
   example checks the origin of its frontend, it must read it from
   `SITE_URL`. A passkey example must read the domain of the passkeys from
   `RP_ID`.
2. If the demo needs secrets, add them as default environment variables of the
   project (see step 4 above).
3. After the first deploy, add the DNS records of its domain.

## Run locally

Use a team access token of a team that you can change. With `--project` and
`--domain`, you do not change the real demos:

```bash
CONVEX_DEMOS_ACCESS_TOKEN=... CONVEX_DEMOS_TEAM_ID=... \
  pnpm --filter demos run deploy --project my-demos-test --domain test.example.com --only github
```

Run `pnpm build` first, because the examples import `@convex-dev/auth` from
`packages/core/dist`.
