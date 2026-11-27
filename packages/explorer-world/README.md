# @convex-dev/explorer-world

A 3D world of a Convex project. It lays out every part of the system from its
structure map (`@convex-dev/explorer-structure`) and plays a real recording of
it (`@convex-dev/explorer`) at human speed. The renderer knows nothing of any
one project: what a project shows comes from its data.

```sh
pnpm --filter @convex-dev/explorer-world dev     # http://localhost:5173
pnpm --filter @convex-dev/explorer-world build   # static app in dist/, relative assets
```

`?project=<name>` picks a project (the first under `projects/` by default):
`convex-auth`, or `chat`, a made-up app under `fixtures/`. `?recording=<name>`
picks one of its recordings; Convex Auth has `page` (a browser driven through
the `react-username-password` scenario) and `cli` (`npx convex run` calls,
including the reuse of a spent refresh token).

## Live mode

Run a Convex app and watch the world react as you use it:

```sh
pnpm explorer:live examples/react-username-password
```

It starts the app's local deployment, turns on the project's step reports,
serves the app's page, opens it in a browser window for you to use, and opens
the world in your default browser. The world shows what your clicks cause as
they happen. Ctrl-C stops everything; the timeline is saved (its path is
printed) and plays like any other recording.

What it needs: Node 20.6 or later, `pnpm install` and `pnpm build` at the root,
and Google Chrome, which the recorder drives through Playwright with nothing
to download. Without Chrome it runs Playwright's Chromium (`npx
playwright@1.63.0 install chromium`); `--browser` picks one. It runs no shell,
so it does not need bash. See `--help` for the options.

The deployment is local, with no Convex account: the command runs `convex dev`
with `CONVEX_AGENT_MODE=anonymous`, which starts a local deployment even when
you are logged in to Convex (a logged-in CLI would otherwise ask which project
to use). It refuses an app whose `.env.local` names a cloud deployment, rather
than switch it behind your back; `--cloud` records that deployment instead,
with `CONVEX_DEPLOY_KEY`. If a deployment already answers at the app's URL,
the command uses it and leaves it running.

Each part runs in its own process group and is stopped as a whole: the
recorder first (it saves the end of the timeline and closes its browser), then
the page's server, then `convex dev` and its backend. When a part fails to
start, the command says which, shows the end of its output (each part logs to
the run directory it prints), and stops the rest. If the browser window is
closed, the recording ends; the world keeps showing it until Ctrl-C.

### How the world plays a live recording

`?live=<url>` gives the world the recorder's stream (`record --serve`, see
`packages/explorer`), which must be on this machine. The world keeps every
event and, after each batch, builds the recording again from all of them, the
way it builds a saved one (a rebuild takes a few ms; the layout is kept until
the recording adds a part to the map, such as the first caller or the page).
Thus once the recording ends, the world equals the world of its file.

Real runs take milliseconds and the world plays at human speed, so the
timeline grows ahead of the playhead: playback is a queue. The timeline bar
says whether it is still recording, how many runs and seconds the playhead is
behind the newest run, and **Skip to live** (End) plays the newest run. At
the end the playhead waits for what comes next. Pause, scrub, step and inspect
work as for a saved recording while events keep arriving.

Events can arrive late or out of order. A rebuild never moves what is on
screen: the playhead keeps its offset into the run it is in. A late run whose
time falls before the playhead is placed where it belongs, in the past, and
the bar counts it ("1 late"); scrub back to see it. A late write, step or link
of a run already on screen joins that run; if the playhead is already past
the point where it plays, it shows at once in its final state (a row appears
rather than flies in), and scrubbing back plays it in full. The recorder holds
a write until its run can have arrived, so this is rare.

### The lag

`check:live` (below) measures it on a local deployment. Medians over runs of
the check, from the moment in question to the line leaving the recorder's
stream: a person's input 3 to 6 ms, a run's end 2 to 4 ms, a write's commit 40
to 95 ms, a call's result in the page 60 to 90 ms. The floors:

- The browser and the log stream report at once: the page through the
  DevTools protocol, the deployment's log stream through a long poll that
  answers as soon as a run ends.
- A write comes from the data sync, which has no push: the recorder polls it
  every 100 ms here (`--poll`), so a write waits 50 ms on average for the
  poll, plus the poll itself.
- A write or a call is held until its run is known, so that it names the
  right run; the run is usually known by then (see `packages/explorer`).

The world adds its own time: it rebuilds the recording (4 ms median here) and
draws a frame. Here the world runs in a headless Chromium with software
rendering, about 120 ms a frame for the whole map, and it received a run's end
24 ms after it (median) and drew it about 300 ms after. Each time the
recording adds a part to the map (the first caller of a kind, the page), the
map is laid out again and the scene mounts afresh, which here holds the page
for a second or so; it happens a few times in a session, early. With a GPU a
frame takes milliseconds; that is not measured here.

## What you see

- **Islands are trust boundaries.** Each app, component, region and sign-in
  method is an island; an island inside another (a child component, the apps
  of the backend region) rises from it as a plateau. The platform islands
  float on a disc, the deployment. Client regions wait on its left; third
  parties stand on its right. Callers seen in the recording (the HTTP API,
  the scheduler) stand on the platform's rim.
- **Parts stand on their islands**, by the shape their kind gets: functions
  are pillars (round for a query, hexagonal for a mutation, square for an
  action), tables are vaults with their rows as cards on top, HTTP routes and
  callers are gates, environment variables are posts, client modules and hooks
  are shards. Parts that share a parent from elsewhere stand together and the
  group is named (the client code of each sign-in method in the browser).
- **Distance is level of detail.** From afar: the islands, their names, and an
  arc between related islands. Nearer: the names of the parts of the islands
  around you. Close up: the source location under each part and the fields of
  each table.
- **Selecting a part lights its dependencies**, in both directions, each kind
  in its color, and dims the rest. The inspector lists them by kind, each with
  its evidence (file and line), and lists the unresolved dependencies; these
  rise from the part as dashed red stubs. Selecting an island draws one arc per
  related island.
- **The page plays too**, when the recording has one: it stands in the
  browser region and calls the runs its calls link to; the tokens its
  requests and responses carry are followed by their secret labels to the
  rows they are; it holds what its storage holds; its inputs, navigations and
  the steps of the scenario play between runs, and the run list is grouped
  by scenario step. A call the recorder could not link to one run stays
  unlinked, with the runs it may be.
- **The recording plays**: a request leaves its caller, calls travel between
  functions, the commit sends its writes to their tables, rows rise in, change
  state and dissolve, a warning shows over the function that logged it, and the
  response returns. Real durations are in milliseconds; the schedule gives each
  step seconds and shows the real duration next to it.

Overlays: **Relations** (arcs between islands), **All links** (all
dependencies, one thin line each), **Unresolved** (every unresolved stub).

## Controls

| Input                         | Action                                               |
| ----------------------------- | ---------------------------------------------------- |
| drag                          | pan across the map                                   |
| ⌘-drag, Ctrl-drag, right-drag | orbit about the point looked at                      |
| wheel                         | zoom toward the cursor                               |
| W A S D, Q E, Shift           | fly; down and up; faster                             |
| click                         | inspect a part, island, row, traveller or held row   |
| O / Overview                  | fly back to the overview                             |
| F / Follow                    | the camera follows the action (on at start)          |
| R, L, U                       | toggle the relations, all links, unresolved overlays |
| Space, ← →                    | play or pause; step to the previous or next beat     |
| timeline, run list            | scrub; click a run to jump to it and inspect it      |

URL parameters for scripted screenshots: `?t=42&paused` opens at 42 s,
`?free` starts at the overview without following, `?select=<part id>` opens
with a part selected, `?noeffects` turns off bloom, `?capture` keeps the
drawing buffer for screenshots, `?diag` shows the diagnostics (below).

## How it is built

Data flows one way: **project data → adapters → model → layout → scene**.

- `projects/<name>/`: a project. `index.ts` exports a `ProjectSource`: its
  structure map, its recorded timeline (NDJSON) and its presentation. A new
  directory is picked up on its own. `projects/convex-auth/` takes the map from
  `@convex-dev/explorer-structure` and holds a recording of the
  `react-username-password` example.
- `presets/convex.json` and `projects/<name>/presentation.json`: the
  presentation, data that says what the data cannot: the shape, noun and
  color of each kind of part, the verb and color of each kind of dependency,
  where a kind of part is drawn (`placeIn`: client code in the region it runs
  in), which field of a table is its state and the color of each state, which
  rows travel with requests and responses, how a step report reads, a
  one-line summary of a part, and the app the recording ran in (`focus`). A
  project's presentation extends the Convex preset.
- `src/adapters/`: the only modules that read the formats of the other
  packages. `convexStructure.ts` maps a structure model to the graph;
  `convexRecording.ts` maps a recorder timeline to the recording and joins
  every name to a part, through the structure package's `joinRecording` first.
  `convexPage.ts` reads the browser feed. They read the event kinds they know
  and count the others (`recording.events`, `recording.unplaced`, shown with a
  reason); add a case there to play a new kind.
- `src/model/`: the graph (`graph.ts`: parts, links, unresolved), the
  recording (`recording.ts`: runs, steps, writes, cargo, each derived fact with
  its `Derivation`), the schedule at human speed (`schedule.ts`) and the state
  of the world at a time, as a pure function (`playback.ts`).
- `src/layout/`: a layout is a strategy, one function from the graph and the
  presentation to placements (`types.ts`). `islands.ts` is the one there is;
  `index.ts` lists strategies by name and a presentation picks one with
  `layout`. A flow from clients to tables, or stacked layers, is a new
  function there (`src/test/layout.test.ts` plugs one in).
- `src/scene/`, `src/ui/`: the three.js scene (React Three Fiber) and the HTML
  overlay. They read the model, the layout and the presentation, nothing else.
  Each shape of part is one instanced mesh, the islands are instanced too, and
  each layer of links is one line batch, so the draw calls do not grow with the
  size of the system; part labels mount only for the islands near the camera.

### When something fails

Nothing that loads can blank the world without saying so. A font of the 3D
labels that does not load, a scene that throws, a browser without WebGL, or a
scene that draws no frame in 30 s shows a notice (`src/problems.ts`); the
panels keep working. `pnpm --filter @convex-dev/explorer-world
check:load-failures` builds the world, serves it from a nested path, and
checks in Chromium that it draws with and without its fonts, says so when
they are refused, and requests nothing from elsewhere.

### What the world derives

The recording does not state everything the world shows. Each fact it works
out carries a `Derivation`, and the inspector shows it with a **derived** badge
and a sentence:

- `write-by-commit-time`: a write the recording does not link to a run goes to
  the run that ended nearest its commit time.
- `scheduled-by-structure`: a run the scheduler started goes to the latest
  earlier run that reached a function the structure map shows scheduling it.
- `cargo-out-inserted`, `cargo-in-updated`: only for a recording without a
  page, which holds neither arguments nor return values. Where the
  presentation says a table's rows travel, a response carries the rows its run
  inserted, and a request carries the rows whose state its run moved away from
  a value (a refresh token it redeemed). With a page, tokens come from data.

A part the recording shows and the map lacks (a caller, a table of a component
from npm) is added and marked **observed**.

## Tests

- `src/test/convexAuth.test.ts`: the whole map is placed and drawable; the real
  recording plays every event; runs and calls map to parts; derived facts are
  marked; rows go through their states.
- `src/test/convexAuthPage.test.ts`: the page's recording: every event of the
  kinds read plays; each refresh presents the token the last response gave;
  the page holds what its storage holds; unlinked calls stay unlinked.
- `src/test/fixture.test.ts`: the made-up chat app (`fixtures/chat`) loads,
  lays out and plays with no code of its own, including derived facts and an
  event kind the world does not know.
- `src/test/independence.test.ts`: no module under `src/` names a part of any
  project.
- `src/test/layout.test.ts`: another layout strategy plugs in; packing does
  not overlap.
- `src/test/live.test.ts`: a recording fed batch by batch ends as the world
  of its file; scrambled, it ends with the same content; a late run keeps the
  playhead in its run; the behind-live measure; `?live=` takes only a local
  URL.

`pnpm --filter @convex-dev/explorer-world check:live` runs `explorer:live` on
`examples/react-username-password` with the recorder's scenario in place of a
person and a headless Chromium in place of the world's window, and checks
that events show while the scenario runs (and the lag, as above), that pause,
scrub back, resume and skip to live work mid-run, that the final world equals
the world of the saved file and received every line, and that no process is
left after Ctrl-C. About two minutes; needs Playwright with a Chromium.

### When the scene draws wrong on one machine

The bloom blurs through a chain of ever smaller textures, so one NaN or
infinite pixel in the scene buffer turns into a large black rectangle, and
the more of the map is on screen, the more of the frame goes black. Whether a
shader gives NaN (a division by zero, a `pow` of a negative number, `atan(0,
0)`, an alpha that overflows half floats) depends on the GPU: a software
renderer can give a finite value where a GPU does not. So the shaders avoid
those operations, and a pass before the bloom replaces any non-finite value
with 0 and clamps the rest (`src/scene/safety.ts`).

`?diag` shows what is needed to find such a problem from one screenshot: the
GPU and what it supports, the size of the canvas and its pixel ratio, the
camera, the count of NaN, infinite and negative pixels in the scene buffer
before the effects (read back once a second), and a switch for each effect
(the composer itself, the sanitize pass, bloom, vignette, fog) and each layer of the scene. Turn
the layers off one at a time until the count drops to 0.

`pnpm --filter @convex-dev/explorer-world check:rendering` checks in
Chromium, at pixel ratio 1 and 2, from the overview, mid range and close up,
that the scene buffer holds no NaN, infinite or negative pixel, and that the
frame with effects has no black area where the frame without has content. It
also draws a quad that outputs NaN and checks that the frame survives it,
and that without the sanitize pass the check would see the black area. It
runs on SwiftShader, which is not a GPU: passing does not prove that a GPU
draws right.

`pnpm --filter @convex-dev/explorer-world check:camera` drives the camera with
the pointer: a drag pans with the point of the ground pressed kept under the
pointer, at the overview and at a flat tilt, and selects nothing even when
pressed on an island; Cmd-drag orbits; a click in place selects, and a click
on empty space clears.

Everything the app needs is bundled, fonts included. Text in the 3D scene goes
through `glyphSafe` so that troika never fetches a fallback font.

## Recording a new timeline

In `examples/react-username-password` (see `packages/explorer` for details):
`pnpm build` at the root; `CONVEX_AGENT_MODE=anonymous npx convex dev --once`,
then run `npx convex dev` in the background with the same variable; `npx
convex env set CONVEX_AUTH_REPORT_STEPS true`; from the root, `pnpm --filter
@convex-dev/explorer record examples/react-username-password --project
convex-auth --out <file>`; drive the app with `npx convex run`; stop the
recorder with Ctrl-C and copy the file to
`projects/convex-auth/recording-cli.ndjson`. For the page's recording, serve
the example with `npx vite --port 5173` and record with `--page
http://localhost:5173 --scenario react-username-password` into
`recording-page.ndjson`.
