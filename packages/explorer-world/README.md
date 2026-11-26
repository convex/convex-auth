# explorer-world

A 3D world of Convex Auth that replays a recorded run. This first scene covers
one slice: username and password sign-up, sign-in, refresh-token rotation, the
reuse of a spent refresh token, the scheduled cleanup, and a failed sign-in.

```sh
pnpm --filter explorer-world dev     # http://localhost:5173
pnpm --filter explorer-world build   # static app in dist/
```

## What you see

- **Regions are trust boundaries.** Each is a floating island with a wall of
  light at its edge: the browser, another holder of a token, the app backend,
  and the components `auth`, `authUsername`, `authPassword` and its child
  `rateLimiter`. The Convex platform is the large disc under the backend and
  the components. It has three places: the token check, where requests enter,
  the deployment key, which signs access tokens, and the scheduler.
- **Functions are crystal pillars.** A mutation is hexagonal, a query round.
  The core lights while the function runs.
- **Tables are vaults; rows are cards.** A row rises in when inserted, flashes
  when patched, and sinks away in red when deleted. `refreshTokens` sits in the
  middle of `auth`, its cards colored by state: issued (cyan), redeemed
  (gold), spent (dark crimson).
- **Travellers are calls, returns, requests and responses.** They carry tokens:
  an access token is a gold coin, a refresh token a cyan key.
- **Distance is level of detail.** From afar you see regions and traffic; closer
  in, function and table names; close up, the fields of each row.

## Controls

| Input                   | Action                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| drag, right-drag, wheel | orbit, pan, zoom                                                          |
| W A S D, Q E, Shift     | fly; down and up; faster                                                  |
| click                   | inspect a region, function, table, row, traveller or held token           |
| O / Overview            | fly back to the overview                                                  |
| F / Follow              | the camera follows the action (on at start; off once you take the camera) |
| Space, ← →              | play or pause; step to the previous or next beat                          |
| timeline                | scrub; click a run in the list to jump to it                              |

URL parameters for scripted screenshots: `?t=42&paused` opens the run at 42 s,
`?noeffects` turns off bloom.

## Code

The world is meant to show any codebase. Its engine and renderer know nothing
of Convex Auth; a project supplies everything specific to it.

- `src/model/types.ts`: the model, in neutral terms: regions (client, platform
  or service), places on the platform (entry, issuer, scheduler), functions,
  tables with an optional state field, token kinds, and a recording of
  function runs with their steps and writes.
- `src/config.ts`: `ProjectConfig`, how a project looks (region colors and
  positions, place positions, row-state colors, token shapes, camera, a row
  caption). Every field but the title is optional; the layout places whatever
  the config leaves out.
- `src/model/schedule.ts`: lays a recording out on a timeline at human speed,
  keeping its order and its causality (writes commit at the end of their run).
- `src/model/playback.ts`: the state of the world at a time, as a pure
  function. Scrubbing back costs the same as playing forward.
- `src/scene/`, `src/ui/`: the three.js scene (React Three Fiber) and the HTML
  overlay. They read the model and the config, nothing else.
- `src/project.ts`: the one line that picks the project.
- `projects/convex-auth/`: this project. `structure.provisional.json` and
  `run.provisional.json` hold the slice and its recorded run in provisional
  formats; `adapter.ts`, the only module that reads them, maps them to the
  model; `config.ts` is its look. `packages/explorer-structure` and
  `packages/explorer` will produce the real formats; only `adapter.ts` changes
  then.

To show another codebase, add `projects/<name>/` with its data, an adapter and
a config, and point `src/project.ts` at it. `src/model/generic.test.ts` plays a
made-up shop through the engine and the layout with no config at all.

Tests: `playback.test.ts` checks the Convex Auth run (time to world state);
`generic.test.ts` checks that nothing assumes Convex Auth.

Everything the app needs is bundled, fonts included. Text in the 3D scene goes
through `glyphSafe` so that troika never fetches a fallback font.
