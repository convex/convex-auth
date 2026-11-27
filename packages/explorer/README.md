# @convex-dev/explorer

Records what a Convex app does on its deployment, so that a viewer can play it
back. A function finishes in milliseconds; the recorder keeps every function
run, every line it logged, and every document it wrote in one ordered
timeline.

It works for any Convex app, with nothing added to the app. It reads two feeds
of the deployment:

- The function logs (`/api/stream_function_logs`, the feed behind
  `npx convex logs`): one entry for each function that a client or the
  scheduler ran, with the lines it logged.
- The data sync API (`/api/v1/data/sync`): every revision of every document,
  in the app and in each component.

A library can add a third, optional feed: [step reports](#step-reports), log
lines that show the steps inside a function, such as its calls into
components, which the logs do not show. Convex Auth writes them.

With `--page`, the recorder also opens the app's page in Chromium and records
[the browser](#record-a-browser): what the person does, the messages of the
Convex sync WebSocket, the calls of the HTTP API, storage, cookies, and
errors. It links each call of the page to its run on the server, and follows
each token from the response that returned it to the row of the server that
stores its hash, without writing the token.

The recorder writes the timeline as NDJSON, one event per line, as the events
arrive, and with `--serve` it also [streams it](#stream-the-timeline) to a
viewer on the same machine. The timeline holds no secret: see
[Redaction](#redaction).

This package is private. It is a development tool of this repository.

## Record a local deployment

Run the app on a local deployment, then record it from the root of the
repository:

```sh
cd examples/react-username-password
npx convex dev            # leave it running
```

```sh
pnpm --filter @convex-dev/explorer record examples/react-username-password \
  --project convex-auth --out run.ndjson
```

Wait for `Recording; press Ctrl-C to stop.`, use the app, then press Ctrl-C.

The recorder reads the deployment URL from the app's `.env.local`
(`VITE_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_URL`,
`PUBLIC_CONVEX_URL`, or `CONVEX_URL`) and the admin key that `npx convex dev`
keeps for a local deployment, in `.convex/local/default/config.json`. For a
self-hosted backend, set `CONVEX_SELF_HOSTED_URL` and
`CONVEX_SELF_HOSTED_ADMIN_KEY` instead.

## Record a cloud deployment

Add `--cloud`, and give a deploy key of the deployment in `CONVEX_DEPLOY_KEY`
(dashboard: Settings, then Deploy Keys). On cloud, the data sync API needs a
Pro plan.

```sh
CONVEX_DEPLOY_KEY='dev:...' pnpm --filter @convex-dev/explorer record \
  examples/react-username-password --cloud --project convex-auth --out run.ndjson
```

The URL comes from the app's `.env.local`, or from `--url`. The recorder warns
when the key is for another deployment than the URL. It never prints the key.

Local and cloud differ only in where the URL and the key come from:
`resolveTarget` in [`src/config.ts`](src/config.ts).

## Record a browser

Serve the app's page against the deployment, then give its URL to `--page`
with a scenario, or with `--headed` to drive the page yourself:

```sh
cd examples/react-username-password
npx convex dev            # leave it running
npx vite --port 5173      # in another terminal: the page, on the same deployment
```

```sh
# A scenario drives the page, then the recorder stops (about 90 s).
pnpm --filter @convex-dev/explorer record examples/react-username-password \
  --project convex-auth --page http://localhost:5173 \
  --scenario react-username-password --out run.ndjson

# You drive the page; close the browser or press Ctrl-C to stop.
pnpm --filter @convex-dev/explorer record examples/react-username-password \
  --project convex-auth --page http://localhost:5173 --headed --out run.ndjson
```

The recorder runs the Chromium that Playwright (`playwright-core` 1.63.0)
installs: `npx playwright@1.63.0 install chromium`. To run another one, give
its path in `--chromium` or `EXPLORER_CHROMIUM`, or name a browser installed
on the machine with `--browser-channel chrome` (or `msedge`, ...): Playwright
finds it where its installer puts it, and nothing is downloaded. Each
recording starts with an empty profile: no storage, no cookies. A window that
a person drives keeps the size they give it.

It reads the browser from the outside, through the Chrome DevTools Protocol:
the HTTP requests and WebSocket frames (`Network`), the changes of
`localStorage` and `sessionStorage` (`DOMStorage`), and, every half second,
the cookies. The console and uncaught errors come from Playwright. It injects
two scripts into each page: a listener of clicks, typing, submits, and the
Enter and Escape keys, which the protocol does not report, and the switch of
the client step reports of Convex Auth (see [Step reports](#step-reports)).
The listener never sends the text of a password field out of the page.

It records the requests of type document, fetch, and XHR, and the sync
WebSocket of the deployment; not the scripts, styles, and images, nor other
WebSockets such as the one of a dev server.

### Scenarios

A scenario is a module whose default export is a `Scenario`
([`src/scenario.ts`](src/scenario.ts)): a name and a `run` function that
drives the page with Playwright through steps. Each step is two `scenario`
events, its start and its end. `--scenario` takes the name of a scenario of
[`src/scenarios/`](src/scenarios/) or the path to a module.

`react-username-password`, for `examples/react-username-password`: sign up,
reload (the session comes back from storage), wait for the refresh that the
page schedules before its access token expires, sign out, sign in with a
wrong password, sign in. The passwords are random on each run.

## Stream the timeline

With `--serve <port>`, the recorder also serves the timeline while it writes
it, over Server-Sent Events at `http://127.0.0.1:<port>/timeline`: every line
written so far, then each new line, then an `end` message when the recording
stops. Each message is one line of the file, the same string, and its `id` is
the line's number (the `recording` event is 0); a client that reconnects with
`Last-Event-ID` gets the lines after it. The file is written as before.

```sh
pnpm --filter @convex-dev/explorer record examples/react-username-password \
  --project convex-auth --page http://localhost:5173 --headed \
  --serve 5199 --serve-origin http://127.0.0.1:5174 --out run.ndjson
```

The server listens on 127.0.0.1 only, and answers only a request whose `Host`
is 127.0.0.1 or localhost on its port and whose `Origin` is one given with
`--serve-origin`: another site's page cannot read it, through the browser or
through DNS rebinding. A request with no `Origin` is refused too. The stream
carries nothing that the file does not: see [Redaction](#redaction).
`explorer-world` reads it in live mode; `pnpm explorer:live` at the root
starts both (see that package's README).

## Options

- `--cloud`: record a cloud deployment, with `CONVEX_DEPLOY_KEY`.
- `--app <name>`: the name of the app in the `recording` event. Default: the
  last segment of the app directory, e.g. `react-username-password`.
- `--out <file>`: where to write the timeline. Default:
  `timeline-<time>.ndjson`. An existing file is overwritten.
- `--url <url>`: the deployment URL.
- `--project <name>`: the project config, which says what the timeline keeps
  of the app's tables. `generic` (the default) or `convex-auth`. See
  [Project configs](#project-configs).
- `--drop-personal-data`: replace the personal data that the project config
  would keep, such as usernames and email addresses.
- `--history <n>`: also record the last `n` function runs before the start.
- `--poll <ms>`: how often to poll the data sync once it caught up. Default: 1000. A write reaches the timeline up to that much after it commits.
- `--settle <ms>`: the longest to hold a write or a call for its run.
  Default: 3000. A write or a call whose run reaches the recorder later than
  that stays unattached. See [When an event is written](#when-an-event-is-written).
- `--page <url>`: open the app's page in Chromium and record it. Needs
  `--scenario` or `--headed`.
- `--scenario <name|file>`: drive the page with a scenario, then stop.
- `--headed`: show the browser. Without `--scenario`, you drive the page.
- `--chromium <path>`: the Chromium to run.
- `--browser-channel <name>`: a browser installed on the machine, by its
  Playwright channel (`chrome`, `msedge`, ...), instead of Playwright's
  Chromium.
- `--serve <port>`: also serve the timeline as it is written; 0 picks a free
  port. See [Stream the timeline](#stream-the-timeline).
- `--serve-origin <origin>`: an origin allowed to read the stream, such as
  `http://127.0.0.1:5174`. Repeat it for more. Needed with `--serve`.

## The timeline

Each line is one event. Every event has a `kind` and a `time` in milliseconds
since the Unix epoch. Events are written as soon as they are ready (see
[When an event is written](#when-an-event-is-written)), thus mostly in order
of `time`, but not always: a reader sorts them. The types, with the meaning of
each field, are in [`src/events.ts`](src/events.ts).

- `recording`: the first line. The version of the format (`v`), the start of
  the recording, the name of the app (`app`), the deployment URL, the name of
  the project config, and with a browser, the page and the scenario.
- `run`: one execution of a function. `id` is the execution id; `time` and
  `endTime` are its start and its end. `componentPath` is `""` for a function
  of the app. `writeCount` is the number of documents it wrote.
- `step`: one step report, with the library that wrote it (`source`), the name
  of the step, and its other fields in `detail`. `runId` is the run that
  reported it.
- `log`: one other line that a function logged, with its level and the
  component and function that logged it.
- `write`: one revision of a document: its table and component, the document
  (`value`, null for a delete), and the commit time (`ts`, nanoseconds as a
  string). `runId` is the run whose transaction wrote it, or null if no run of
  the timeline matches. `snapshot` is true for the state of the document when
  the recorder started.

With `--page`, the browser adds these kinds. They came after version 1 of
the format and change none of the kinds above; a viewer ignores the kinds it
does not know.

- `page`: a tab opened, navigated, loaded, or closed (`pageId` names the tab).
- `input`: what the person did: a click, the text of a field (once they
  paused or left it), a submit, or Enter or Escape, with the element.
- `http`: a request of the page and its response. For a call of the HTTP API
  of the deployment (`/api/query`, `/api/mutation`, `/api/action`), the
  function, its arguments, and its result; for any other request, no body.
- `socket`: a message on the sync WebSocket, sent or received, by its type
  (`Connect`, `ModifyQuerySet`, `Mutation`, `Action`, `Authenticate`,
  `Transition`, `MutationResponse`, `ActionResponse`, `AuthError`, ...), with
  its fields redacted; or the socket opening or closing.
- `storage`: a change of `localStorage` or `sessionStorage`: the key, the
  value, and the value it replaced.
- `cookie`: a cookie that appeared, changed, or went away.
- `console`: an error or a warning of the page, or an uncaught error.
- `scenario`: the start, the end, or the error of a step of the scenario.
- `call`: one call of a function that the page made, from the message that
  sent it to the one that brought its result, with the run on the server
  (`runId`) or the reason it has none (`unlinked`). A query makes one call
  per result that reached the page.
- `secret`: the first sighting of a token. See
  [Following tokens](#following-tokens).
- `secretLink`: a token and the row of the server that belongs to it.

### When an event is written

The feeds are not in step, and a write or a call of the page names its run
only once the recorder has the run, from the log stream. Thus the recorder
writes each event as soon as nothing it depends on can still arrive:

- A run, its lines, a write of the initial snapshot, and every event of the
  browser except a call: at once.
- A write of a transaction, and a call: once every run it could attach to
  is known. The log stream gives the runs in the order they ended, so that is
  the case for a write once a run holds its commit time with as many writes
  as the commit has (a run that fits better ended earlier), and for a call
  once a run that ended after the call's result is known.
- Otherwise, once the log stream is known to be read past the moment the
  event arrived, plus 25 ms. The deployment writes the log entry of a run as
  the run ends, before or within a few ms of the moment the page sees its
  result. The log stream is a long poll that answers at once when it has a
  new entry, so the recorder knows it is read up to a moment when a request
  sent then comes back, or when a probe sent then is still unanswered after
  three of the shortest round trips seen (at least 50 ms).
- Anything still held after `--settle` is written then.

Thus a write or a call links to the same run as it would with every run
known. Measured on a local deployment (`pnpm --filter
@convex-dev/explorer-world check:live`), from the moment in question to the
line leaving the recorder, medians over runs of the check: a person's input
3 to 6 ms, a run's end 2 to 4 ms, a write's commit 40 to 95 ms, a call's
result in the page 60 to 90 ms. A write waits for the data sync, which the
recorder polls every `--poll` ms (`explorer:live` sets 100); the data sync
has no push.

### How a write finds its run

All the writes of one transaction share one commit time, and it falls between
the start and the end of the mutation that made them. The recorder attaches
each write to the successful mutation whose window holds its commit time. When
several windows hold it, the run that ended closest after it wins, and among
those, the one whose `writeCount` matches.

### How a call finds its run

The page and the logs share no id: the `requestId` of a socket message is the
client's counter, and the `requestId` of a run is the server's. The recorder
links a call from what both sides know:

- A mutation over the socket that succeeded (`link: "commitTs"`): its
  response carries the commit time (`ts`), which falls in the window of
  exactly one run of the function, on the deployment's own clock. The writes
  of that run carry the same `ts`. This link is exact.
- Any other call (`link: "window"`): the run of the same function, from the
  same caller (`SyncWorker` for the socket, `HttpApi` for HTTP), that ran
  between the call and its result. The recorder aligns the deployment's clock
  with its own from the `serverTs` of each `Transition` (a lower bound of the
  offset, the latency short), and allows 10 ms to spare. A query answered from
  the cache keeps the start of the execution that filled the cache, thus only
  its end must fall in the window.

When several runs fit, the one whose number of log lines equals the number
the response gives wins. When that still leaves several, the call stays
unlinked and lists them in `candidateRunIds`: one of them is the run, and the
data does not say which. It happens for queries: when the page subscribes to
a query, drops it, and subscribes again (React's StrictMode does), the server
runs it once for each subscription, and both runs fit the one result. A run
links to one call at most.

The sync worker also runs a subscribed query again when the identity of the
socket changes; when the result equals the last one, nothing reaches the page,
thus such a run has no call.

On the scenario of `examples/react-username-password`, every mutation of the
page is linked (by commit time over the socket, by window over HTTP), and
about half of the query results; the others list their candidates.

### Following tokens

No token reaches the timeline. The recorder gives each value that looks like a
token a label of the recording, `{ "$secret": "s3" }`, in place of the value:
the same value gets the same label everywhere, in a socket message, an HTTP
body, storage, or a cookie. The first sighting makes a `secret` event. For a
JWT, it holds the numeric claims (`exp`, `iat`, `nbf`) and the string claims
that the project config keeps; never the encoded token or its signature.

The recorder also sees the raw documents of the data sync before it redacts
them. When the project config names a row that stores a digest of a token
(`secretDigests`), the recorder computes the digest of each token of the
browser and writes a `secretLink` to the row with the same digest. When it
names a claim that holds the id of a row (`claimLinks`), it links the JWT to
that row. It writes neither the token nor the digest.

With `--project convex-auth`, a reader can follow the refresh token of a
sign-in: the `MutationResponse` that returned it as `s2`, the `storage` event
that stored `s2` under `__convexAuthRefreshToken_...`, the `http` call of
`auth:refreshSession` that presented `s2`, and the `secretLink` from `s2` to
`auth/refreshTokens/<id>`, whose `write` events show its `state` go from
`issued` to `redeemed` to `spent`. The access token in an `Authenticate`
message is a `secret` of type `jwt` whose `sub` is its session, with a
`secretLink` to `auth/sessions/<sub>`, and whose `exp` is its expiry.

## Step reports

A library writes a step report as one log line: the prefix `[explorer:step] `,
then JSON with the version of the format, the name of the library, and the
name of the step. Other fields are up to the library.

```ts
console.log(
  "[explorer:step] " +
    JSON.stringify({ v: 1, source: "my-library", step: "cache.hit" }),
);
```

The recorder accepts any `source` and any step, and a report with a newer or a
missing `v`. A report must hold no secret and no personal data; the recorder
scrubs what looks like a token from it all the same.

Convex Auth writes step reports when the deployment's
`CONVEX_AUTH_REPORT_STEPS` variable is `true`:

```sh
npx convex env set CONVEX_AUTH_REPORT_STEPS true
```

Its client writes them to the console of the page when the page's
`__CONVEX_AUTH_REPORT_STEPS__` global is `true` before the client runs. The
recorder sets it in every page it records, with a stage or without one, so the
app's code does not change. A client report adds `runsIn: "browser"` and
`part`, the id in `packages/explorer-structure` of the module that ran the
step, such as `module:browser/sessionManager`. It names a stored value by its
logical key and namespace (`__convexAuthJWT` and `http1270013210` for
`__convexAuthJWT_http1270013210`), never by its value. See
[`packages/core/src/browser/steps.ts`](../core/src/browser/steps.ts).

The recorder writes a report of a function's logs as a `step` event with
`from: "function"` and the `runId` of its run, and a report of the page as a
`step` event with `from: "page"`, the `pageId`, `runId: null`, and `runsIn`
and `part` taken out of `detail`. A report of the page is not a `console`
event.

## Redaction

A document keeps a field only when it is known to be safe:

- A field whose name looks like a secret (`hash`, `secret`, `token`, `code`,
  `challenge`, `publicKey`, ...) is replaced by `"[redacted]"` in every table.
- Ids (`_id`, and `...Id` fields that hold a Convex id), `_creationTime`,
  numbers, booleans, and null are kept.
- Every other string is replaced, unless the project config keeps the field.

Thus without a project config, the timeline shows the ids, numbers, flags, and
timestamps of every table, and none of its strings.

The text of log lines, errors, and step reports goes through `scrubText`, which
replaces JWTs, PHC hashes, long hex strings, Convex keys, and random-looking
runs of base64.

The values of the browser feed (arguments, results, query results, storage)
follow the same idea, by the name of their key, since they have no table:

- A value that looks like a token (a JWT, long hex, or a random run of base64)
  or whose key looks like a secret becomes a label (see
  [Following tokens](#following-tokens)). So does each cookie value, and the
  value of a storage key that the project config names.
- A value whose key looks like a password (`password`, `passphrase`, ...) is
  replaced by `"[redacted]"`, without a label: equal labels would tell that
  two passwords are equal.
- Convex ids, numbers, booleans, and null are kept.
- Every other string is replaced, unless the project config keeps its key.
- A URL keeps its origin and path; each query value becomes a label or
  `"[redacted]"`, and so does the fragment.
- The text that a person types follows the rule of the field's `name`, `id`,
  or `autocomplete`; the text of a password field never leaves the page.

## Project configs

A project config ([`src/project.ts`](src/project.ts)) names the string fields
of an app's tables that the timeline keeps:

- `safeFields`: fields that hold no secret and no personal data, such as the
  `state` of a refresh token.
- `personalFields`: fields that hold personal data, such as a username. The
  timeline keeps them only when `keepPersonalData` is true;
  `--drop-personal-data` turns it off.
- `urlFields`: fields that hold a URL whose origin and path are safe, such as
  the page to return to after an OAuth provider. The timeline keeps the origin
  and the path, and replaces the query values and the fragment.
- `browser`: what the timeline keeps of the browser feed. `safeKeys` and
  `personalKeys` name the keys of the values of the page, as `safeFields` and
  `personalFields` do for tables; `secretStorageKeys` the storage keys that
  hold a token; `safeJwtClaims` the string claims of a JWT to keep;
  `secretDigests` and `claimLinks` how a token maps to a row (see
  [Following tokens](#following-tokens)). Without it, the browser feed keeps
  ids, numbers, and flags, labels every token, and links none.

The configs are in [`src/projects/`](src/projects/). `convex-auth` covers the
tables of the Convex Auth components and the storage keys, values, and tokens
of its clients, and keeps personal data by default. In it,
`accounts.providerAccountId` and `passkeys.name` are personal: the first names
a person at an OAuth provider, the second is text a person typed.
`authorizationRequests.redirectTo` is a URL field: the client names it, and
its query can hold anything the app put there. `callbackUrl` is kept whole:
the backend builds it from its site URL and a fixed path. To
record another app, add a config there and name it in
[`src/projects/index.ts`](src/projects/index.ts).

## Development

```sh
pnpm test --project explorer
pnpm --filter @convex-dev/explorer typecheck
```

The pure modules (`src/logs.ts`, `src/logPoller.ts`, `src/sync.ts`,
`src/timeline.ts`, `src/redact.ts`, `src/config.ts`, `src/secrets.ts`,
`src/browser.ts`, `src/calls.ts`) run in any runtime; `src/recorder.ts`,
`src/browserRecorder.ts`, `src/scenario.ts`, `src/stream.ts`, and
`src/cli.ts` are the Node-only part. The tests use feeds captured from a local backend in
`src/fixtures/`, with each hash replaced by a fake. `browser-session.json`
holds what a browser showed the recorder during a session, with each JWT
re-signed by a fake signature, each refresh token a fake, and each hash the
SHA-256 of the fake token.

The log stream does not give the deployment's time, only the time of its
entries. To keep the runs that finished after the start and drop the earlier
ones, the recorder reads the deployment's clock from the `Date` header of the
first response, which is rounded down to the second. Thus a run that finished
up to about a second before the start can be kept; a run that finished after
it is never dropped. Without the header, the recorder's clock stands in: right
for a local deployment, off by the skew of the clocks for a cloud one.

To check on a running deployment that the recorder keeps the first function
run after it starts:

```sh
pnpm --filter @convex-dev/explorer check:first-run examples/react-username-password \
  --function auth:isAuthenticated --times 3
```

To record the scenario of `examples/react-username-password` with the
browser, and check that each call of the page is linked to a run or says why
not, that each refresh token can be followed from its response to its row,
that each access token on the socket has its session and expiry, and that the
file holds none of the secrets that the recorder saw, no `eyJ`, no PHC string,
and no 64-hex string:

```sh
pnpm --filter @convex-dev/explorer check:browser examples/react-username-password \
  --page http://localhost:5173
```

The deployment needs `CONVEX_AUTH_REPORT_STEPS=true`, and the page must be
served against it.
