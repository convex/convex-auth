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
`convex-auth`, or `chat`, a made-up app under `fixtures/`.

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
- **The recording plays**: a request leaves its caller, calls travel between
  functions, the commit sends its writes to their tables, rows rise in, change
  state and dissolve, a warning shows over the function that logged it, and the
  response returns. Real durations are in milliseconds; the schedule gives each
  step seconds and shows the real duration next to it.

Overlays: **Relations** (arcs between islands), **All links** (all
dependencies, one thin line each), **Unresolved** (every unresolved stub).

## Controls

| Input                   | Action                                               |
| ----------------------- | ---------------------------------------------------- |
| drag, right-drag, wheel | orbit, pan, zoom                                     |
| W A S D, Q E, Shift     | fly; down and up; faster                             |
| click                   | inspect a part, island, row, traveller or held row   |
| O / Overview            | fly back to the overview                             |
| F / Follow              | the camera follows the action (on at start)          |
| R, L, U                 | toggle the relations, all links, unresolved overlays |
| Space, ← →              | play or pause; step to the previous or next beat     |
| timeline, run list      | scrub; click a run to jump to it and inspect it      |

URL parameters for scripted screenshots: `?t=42&paused` opens at 42 s,
`?free` starts at the overview without following, `?select=<part id>` opens
with a part selected, `?noeffects` turns off bloom, `?capture` keeps the
drawing buffer for screenshots.

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
  every name to a part. It reads the event kinds it knows and counts the
  others (`recording.events`, `recording.unplaced`); add a case there to play a
  new kind.
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

### What the world derives

The recording does not state everything the world shows. Each fact it works
out carries a `Derivation`, and the inspector shows it with a **derived** badge
and a sentence:

- `write-by-commit-time`: a write the recording does not link to a run goes to
  the run that ended nearest its commit time.
- `scheduled-by-structure`: a run the scheduler started goes to the latest
  earlier run that reached a function the structure map shows scheduling it.
- `cargo-out-inserted`, `cargo-in-updated`: the recording holds neither
  arguments nor return values. Where the presentation says a table's rows
  travel, a response carries the rows its run inserted, and a request carries
  the rows whose state its run moved away from a value (a refresh token it
  redeemed).

A part the recording shows and the map lacks (a caller, a table of a component
from npm) is added and marked **observed**.

## Tests

- `src/test/convexAuth.test.ts`: the whole map is placed and drawable; the real
  recording plays every event; runs and calls map to parts; derived facts are
  marked; rows go through their states.
- `src/test/fixture.test.ts`: the made-up chat app (`fixtures/chat`) loads,
  lays out and plays with no code of its own, including derived facts and an
  event kind the world does not know.
- `src/test/independence.test.ts`: no module under `src/` names a part of any
  project.
- `src/test/layout.test.ts`: another layout strategy plugs in; packing does
  not overlap.

Everything the app needs is bundled, fonts included. Text in the 3D scene goes
through `glyphSafe` so that troika never fetches a fallback font.

## Recording a new timeline

In `examples/react-username-password` (see `packages/explorer` for details):
`pnpm build` at the root; `CONVEX_AGENT_MODE=anonymous npx convex dev --once`,
then run `npx convex dev` in the background with the same variable; `npx
convex env set CONVEX_AUTH_REPORT_STEPS true`; from the root, `pnpm --filter
@convex-dev/explorer record examples/react-username-password --project
convex-auth --out <file>`; drive the app with `npx convex run`; stop the
recorder with Ctrl-C and copy the file to `projects/convex-auth/recording.ndjson`.
