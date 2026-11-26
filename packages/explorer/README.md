# @convex-dev/explorer

Records what a Convex Auth app does on its deployment, so that a viewer can
play it back. A sign-in finishes in milliseconds; the recorder keeps every
function run, every step of the library, and every document write of it in one
ordered timeline.

The recorder reads two feeds of the deployment:

- The function logs, from `npx convex logs --jsonl`: one entry for each
  function that a client or the scheduler ran, with the lines it logged.
- The data sync API (`POST /api/v1/data/sync`): every revision of every
  document, in the app and in each component.

It writes the timeline as NDJSON, one event per line, as the events arrive.
The timeline holds no secret: see [Redaction](#redaction).

This package is private. It is a development tool of this repository.

## Record a cloud dev deployment

1. Turn on the step reports of the library (once per deployment):

   ```sh
   cd examples/react-username-password
   npx convex env set CONVEX_AUTH_REPORT_STEPS true
   ```

   Without them, the timeline still has the runs and the writes, but not the
   calls into the components, which the logs do not show.

2. Create a deploy key for the dev deployment: in the dashboard, Settings, then
   Deploy Keys. The data sync API on cloud needs a Pro plan.

3. Record, from the root of the repository:

   ```sh
   CONVEX_DEPLOY_KEY='dev:...' pnpm --filter @convex-dev/explorer record \
     examples/react-username-password --out run.ndjson
   ```

   Wait for `Recording; press Ctrl-C to stop.`, use the app, then press
   Ctrl-C.

The recorder reads the deployment URL from the app's `.env.local`
(`VITE_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_URL`,
`PUBLIC_CONVEX_URL`, or `CONVEX_URL`), or from `--url`. `npx convex logs` runs
in the app directory, with `CONVEX_DEPLOY_KEY` set, thus it reads the same
deployment. The recorder never prints the key.

For a local deployment (`CONVEX_DEPLOYMENT=anonymous:...` or `local:...` in
`.env.local`), it needs no `CONVEX_DEPLOY_KEY`: it reads the admin key from
`.convex/local/default/config.json`.

Options:

- `--out <file>`: where to write the timeline. Default:
  `timeline-<time>.ndjson`. An existing file is overwritten.
- `--url <url>`: the deployment URL.
- `--history <n>`: also record the last `n` function runs before the start.
- `--poll <ms>`: how often to poll the data sync once it caught up. Default: 1000.
- `--settle <ms>`: how long to hold an event for the other feed. Default: 3000.
  A write whose run reaches the recorder later than that stays unattached.

## The timeline

Each line is one event. Every event has a `kind` and a `time` in milliseconds
since the Unix epoch. The file is sorted by `time`, except that an event that
arrives more than `--settle` late is written when it arrives. The types, with
the meaning of each field, are in [`src/events.ts`](src/events.ts).

- `recording`: the first line. The version of the format (`v`), the start of
  the recording, and the deployment URL.
- `run`: one execution of a function. `id` is the execution id; `time` and
  `endTime` are its start and its end. `componentPath` is `""` for a function
  of the app. `writeCount` is the number of documents it wrote.
- `step`: one step report of the library, such as `method.start`, `call`,
  `return`, `session.issued`, or `method.result`, with its other fields in
  `detail`. `runId` is the run that reported it. A viewer shows a step it does
  not know as it is.
- `log`: one other line that a function logged, with its level and the
  component that logged it.
- `write`: one revision of a document: its table and component, the document
  (`value`, null for a delete), and the commit time (`ts`, nanoseconds as a
  string). `runId` is the run whose transaction wrote it, or null if no run of
  the timeline matches. `snapshot` is true for the state of the document when
  the recorder started.

### How a write finds its run

All the writes of one transaction share one commit time, and it falls between
the start and the end of the mutation that made them. The recorder attaches
each write to the successful mutation whose window holds its commit time. When
several windows hold it, the run that ended closest after it wins, and among
those, the one whose `writeCount` matches.

## Redaction

A document keeps a field only when it is known to be safe:

- A field whose name looks like a secret (`hash`, `passwordHashPHC`, `secret`,
  `token`, `code`, `challenge`, `publicKey`, ...) is replaced by
  `"[redacted]"` in every table.
- Ids (`_id`, and `...Id` fields that hold a Convex id), `_creationTime`,
  numbers, booleans, and null are kept.
- Other strings are kept only in the fields that `SAFE_FIELDS` in
  [`src/redact.ts`](src/redact.ts) lists for the tables of the Convex Auth
  components, such as `state` of `refreshTokens` and `username` of
  `usernames`. In a table it does not know, the recorder replaces every other
  string.

The text of log lines, errors, and step reports goes through `scrubText`, which
replaces JWTs, PHC hashes, long hex strings, Convex keys, and random-looking
runs of base64.

Usernames and email addresses are kept: they are not secrets, and a viewer of a
dev deployment needs them to tell users apart.

## Development

```sh
pnpm test --project explorer
pnpm --filter @convex-dev/explorer typecheck
```

The pure functions (`src/logs.ts`, `src/sync.ts`, `src/timeline.ts`,
`src/redact.ts`) run in any runtime; `src/cli.ts` is the Node-only part. The
tests use feeds captured from a local backend in `src/fixtures/`, with each
hash replaced by a fake.
