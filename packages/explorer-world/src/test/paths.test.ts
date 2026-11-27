/**
 * The paths of the stage (`stage/paths.ts`) on a recorded session of
 * `examples/react-username-password` driven on the stage: sign up, a
 * reload, the scheduled refresh, sign out, sign in. The fixture is the
 * timeline `explorer:live` saved (`fixtures/stage-session.ndjson`); its
 * username is a throwaway and it holds no token.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { stageFromEvents } from "../adapters/browserStage.ts";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { stageAt } from "../stage/model.ts";
import { BEAT_MS, legsAt, realOf, shownOf, type Leg } from "../stage/paths.ts";

const text = readFileSync(
  new URL("./fixtures/stage-session.ndjson", import.meta.url),
  "utf8",
);
const events = parseNdjson(text);
const model = stageFromEvents(events);
const real = (e: { time?: number }) => e.time as number;

/** The person's submits and the reload, in real time. */
const submits = events
  .filter((e) => e.kind === "input" && e.action === "submit")
  .map(real);
const signOutClick = events.find(
  (e) =>
    e.kind === "input" &&
    e.action === "click" &&
    String((e.target as { text?: string }).text) === "Sign out",
);

/** The legs that start within `ms` (real) after `from`, in order. */
const legsAfter = (from: number, ms: number): Leg[] =>
  model.legs
    .filter((l) => l.realStart >= from && l.realStart < from + ms)
    .sort((a, b) => a.start - b.start);
const describe = (l: Leg) =>
  l.kind === "call"
    ? `call ${l.label}`
    : `${l.kind} ${l.kind === "read" ? (l.from as { key: string }).key : (l.to as { key: string }).key}`.replace(
        /_http\d+$/,
        "",
      );

test("a sign-up: out to the backend and back, then into the two keys", () => {
  const legs = legsAfter(submits[0], 1200).map(describe);
  expect(legs[0]).toBe("call auth:signUpWithUsernamePassword");
  expect(legs).toContain("write __convexAuthJWT");
  expect(legs).toContain("write __convexAuthRefreshToken");
  // The writes come after the call returned.
  const call = model.legs.find(
    (l) => l.label === "auth:signUpWithUsernamePassword",
  )!;
  for (const l of legsAfter(submits[0], 1200))
    if (l.kind === "write") expect(l.start).toBeGreaterThanOrEqual(call.end);
});

test("a reload: the client reads both keys back", () => {
  // Only a page that starts reads the access token back.
  const reload = events.find(
    (e) =>
      e.kind === "step" &&
      e.from === "page" &&
      e.step === "storage.read" &&
      (e.detail as { key?: string }).key === "__convexAuthJWT" &&
      (e.detail as { found?: boolean }).found === true,
  )!;
  const legs = legsAfter(real(reload) - 1, 50).map(describe);
  expect(legs).toEqual([
    "read __convexAuthJWT",
    "read __convexAuthRefreshToken",
  ]);
});

test("a sign-out: the call, then each key removed once", () => {
  expect(signOutClick).toBeDefined();
  const legs = legsAfter(real(signOutClick!), 1000).map(describe);
  expect(legs).toContain("call auth:signOut");
  // The client removes each key twice; the second changes nothing, so it
  // has no leg.
  expect(legs.filter((l) => l === "remove __convexAuthJWT")).toHaveLength(1);
  expect(
    legs.filter((l) => l === "remove __convexAuthRefreshToken"),
  ).toHaveLength(1);
});

test("a leg only where the recording links its ends", () => {
  for (const l of model.legs) {
    // Never from an input: nothing records which input led to a step.
    expect(l.from.type).not.toBe("element");
    if (l.kind === "write" || l.kind === "remove") {
      // It ends on the storage change of its key.
      const key = (l.to as { key: string }).key;
      const change = events.find(
        (e) =>
          e.kind === "storage" &&
          e.key === key &&
          real(e) === l.realEnd &&
          e.op === (l.kind === "write" ? "set" : "remove"),
      );
      expect(change).toBeDefined();
    }
    if (l.kind === "call") {
      const call = events.find(
        (e) => e.kind === "call" && `leg:${e.id}` === l.id,
      );
      expect(call?.requestEventId).toBeTruthy();
    }
  }
});

test("partway through a leg, its traveller is between its two ends", () => {
  for (const l of model.legs) {
    const mid = (l.start + l.end) / 2;
    const at = legsAt([l], mid)[0];
    expect(at).toBeDefined();
    if (l.kind === "call") expect(at.along).toBeGreaterThan(0);
    else {
      expect(at.along).toBeGreaterThan(0);
      expect(at.along).toBeLessThan(1);
    }
    expect(legsAt([l], l.start - 1)).toHaveLength(0);
    expect(legsAt([l], l.end + 1)).toHaveLength(0);
  }
});

test("the stretch keeps the order and spreads the beats out", () => {
  const b = model.beats;
  for (let i = 1; i < b.length; i++) {
    expect(b[i].real).toBeGreaterThanOrEqual(b[i - 1].real);
    expect(b[i].time - b[i - 1].time).toBeGreaterThanOrEqual(BEAT_MS - 1e-6);
    // A gap longer than a beat stays as long as it was.
    const gap = b[i].real - b[i - 1].real;
    if (gap > 2000)
      expect(b[i].time - b[i - 1].time).toBeGreaterThanOrEqual(gap - 1e-6);
  }
  // Real and shown times map both ways (beats at the same real time map
  // back to the first of them).
  const firsts = b.filter((x, i) => i === 0 || x.real !== b[i - 1].real);
  for (const t of [model.start, ...firsts.map((x) => x.time), model.end])
    expect(shownOf(model.warp, realOf(model.warp, t))).toBeCloseTo(t, 3);
});

test("scrubbing back gives the same state as going forward", () => {
  const times: number[] = [];
  for (let t = model.start; t <= model.end; t += 97) times.push(t);
  const key = (t: number) => {
    const s = stageAt(model, t);
    return JSON.stringify({
      legs: s.legs.map((l) => [l.leg.id, l.along.toFixed(4), l.phase]),
      beats: s.beats.map((x) => [x.beat.id, x.lit.toFixed(4)]),
      thens: s.thens.map((x) => x.then.id),
      local: s.local.map((x) => [x.slot.key, x.settled.toFixed(4)]),
      flights: s.flights.map((f) => [f.flight.id, f.along.toFixed(4)]),
    });
  };
  const forward = times.map(key);
  const back = [...times].reverse().map(key).reverse();
  expect(back).toEqual(forward);
});

test("quiet when nothing is happening", () => {
  // Between the sign-in and the scheduled refresh: tens of seconds of
  // nothing but pings.
  const s = stageAt(model, shownOf(model.warp, submits[1] + 20_000));
  expect(s.legs).toEqual([]);
  expect(s.beats).toEqual([]);
  expect(s.thens).toEqual([]);
});
