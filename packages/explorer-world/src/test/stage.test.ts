/**
 * The stage's model of a recording's browser feed, and its state at a time.
 */
import { expect, test } from "vitest";
import { stageFromEvents } from "../adapters/browserStage.ts";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { PROJECTS } from "../project.ts";
import { screenUrl } from "../stage/frame.ts";
import { LAND_MS, stageAt, TRAVEL_MS } from "../stage/model.ts";

const events = parseNdjson(PROJECTS["convex-auth"].timelines.page);
const model = stageFromEvents(events);

test("the browser feed becomes the stage's things", () => {
  const kinds = (k: string) => events.filter((e) => e.kind === k);
  // Every message of the socket and every request is one flight.
  const messages = kinds("socket").filter(
    (e) => e.direction === "sent" || e.direction === "received",
  );
  expect(model.flights.length).toBe(messages.length + kinds("http").length);
  // Each storage key is one slot; a token is held by its label, never text.
  expect(model.local.length).toBeGreaterThan(0);
  for (const slot of model.local)
    for (const held of slot.held) {
      expect(held.secrets.length).toBeGreaterThan(0);
      expect(typeof held.value).toBe("object");
    }
  // The exits present from the start.
  expect(model.exits.map((e) => e.id)).toEqual(["backend", "page"]);
  // The elements the person used, in order of first use.
  expect(model.elements.map((e) => e.order)).toEqual(
    model.elements.map((_, i) => i),
  );
});

test("a storage key holds one value at a time", () => {
  for (const slot of model.local) {
    for (let i = 1; i < slot.held.length; i++) {
      const before = slot.held[i - 1].to;
      expect(before).not.toBeNull();
      expect(before!).toBeLessThanOrEqual(slot.held[i].from);
    }
  }
});

test("the state is a function of the time, in both directions", () => {
  const times: number[] = [];
  for (let t = model.start; t <= model.end + 2000; t += 97) times.push(t);
  const forward = times.map((t) => JSON.stringify(view(t)));
  const backward = [...times]
    .reverse()
    .map((t) => JSON.stringify(view(t)))
    .reverse();
  expect(backward).toEqual(forward);
});

function view(t: number) {
  const s = stageAt(model, t);
  return {
    path: s.path,
    elements: s.elements.map((e) => [e.element.key, e.lit]),
    local: s.local.map((x) => [x.held.eventId, x.settled, x.leaving]),
    flights: s.flights.map((f) => [f.flight.id, f.along, f.phase]),
  };
}

test("a token lands, rests, and leaves when replaced", () => {
  const slot = model.local[0];
  const at = (t: number) =>
    stageAt(model, t).local.filter((x) => x.slot.key === slot.key);
  expect(at(slot.held[0].from - 1)).toEqual([]);
  // A value that stays a while: it lands, then rests.
  const i = slot.held.findIndex(
    (h, k) =>
      k > 0 &&
      (h.to ?? Infinity) - h.from > LAND_MS * 2 &&
      h.from - slot.held[k - 1].to! < 1,
  );
  const held = slot.held[i];
  const mine = (t: number) => at(t).find((x) => x.held === held)!;
  expect(mine(held.from + LAND_MS / 2).settled).toBeCloseTo(0.5);
  expect(mine(held.from + LAND_MS / 2).leaving).toBe(false);
  expect(mine(held.from + LAND_MS * 1.5).settled).toBe(1);
  // The value it replaced (and any replaced just before) leaves meanwhile;
  // one value is held.
  const swap = at(held.from + LAND_MS / 2);
  expect(swap.filter((x) => !x.leaving)).toHaveLength(1);
  expect(swap.filter((x) => x.leaving).length).toBeGreaterThan(0);
});

test("a message is on its way only after it happened", () => {
  const f = model.flights.find((x) => x.via === "socket")!;
  const here = (t: number) =>
    stageAt(model, t).flights.find((x) => x.flight.id === f.id);
  expect(here(f.time - 1)).toBeUndefined();
  expect(here(f.time + TRAVEL_MS / 2)?.along).toBeCloseTo(
    f.direction === "out" ? 0.5 : 0.5,
  );
  expect(here(f.time + TRAVEL_MS + 1)).toBeUndefined();
});

test("nothing moves in an empty recording", () => {
  const empty = stageFromEvents([]);
  const s = stageAt(empty, Date.now());
  expect(s.flights).toEqual([]);
  expect(s.local).toEqual([]);
  expect(s.elements).toEqual([]);
});

test("?screen= must be on the stage's host", () => {
  const stage = new URL(
    "http://localhost:5174/stage.html",
  ) as unknown as Location;
  expect(screenUrl("http://localhost:5173", stage)?.port).toBe("5173");
  expect(() => screenUrl("http://127.0.0.1:5173", stage)).toThrow();
  expect(() => screenUrl("https://example.com", stage)).toThrow();
  expect(screenUrl(null, stage)).toBeNull();
});
