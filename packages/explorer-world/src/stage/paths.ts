/**
 * The path of what the client did, as movement: who reported what, and
 * where a recorded link carries it next.
 *
 * A path is made of two things, both taken from the recording only:
 *
 * - **Beats**: one for each event that happened at a place of the stage: a
 *   person's input (at its element), a step the client reported (at the
 *   module that ran it), a call leaving or returning (at the mouth of its
 *   channel), a storage change (at its key).
 * - **Legs**: a movement from one place to another, drawn only where the
 *   recording links the two ends:
 *   - a storage step to the storage event of its key (`write`, `remove`):
 *     the step names the key and its namespace, and the event is the next
 *     change of `key + "_" + namespace` after it, of the same kind;
 *   - a storage read to the key it read (`read`), when the step says the
 *     key was found and the key holds a value then;
 *   - a call to its request and its response (`call`): the `call` event
 *     names both messages (`requestEventId`, `responseEventId`).
 *
 * Two beats in a row with no link between them (an input and the
 * `signIn.call` that followed it, a `signIn.call` and the message that
 * left) are only next to each other in time: they are drawn as a "then",
 * a faint dashed line, never as a traveller.
 *
 * Time: real steps happen within milliseconds of each other. The stage
 * shows them in a stretched time, the **shown time**: consecutive beats are
 * at least {@link BEAT_MS} apart, so each can be followed; a gap that is
 * already longer stays as it was. The order never changes. Every time of
 * the model is mapped through the same stretch ({@link Warp}), so storage,
 * messages and paths stay in step, and the time handle scrubs shown time:
 * it moves smoothly both ways. The stretch is shown on the time track, and
 * the inspector gives real times.
 *
 * @module
 */
import type { Flight, StageModel } from "./model.ts";

/** The least shown time between two consecutive beats, in ms. */
export const BEAT_MS = 240;
/** Beats further apart than this (real ms) are not joined by a "then". */
export const THEN_GAP_MS = 1500;
/** How long a "then" stays drawn, in shown ms. */
export const THEN_MS = 900;
/** How long a beat's place stays lit, in shown ms. */
export const BEAT_LIT_MS = 1100;
/** The least drawn length of a leg, in shown ms. */
export const LEG_MIN_MS = 420;
/**
 * The least shown time from a leg's first beat to its last: a call goes a
 * long way out to its exit and back, a write a shorter way to its key.
 */
export const CALL_MIN_MS = 1500;
export const STORE_MIN_MS = 800;

/** A place of the stage a beat happens at. */
export type Place =
  | { type: "element"; key: string }
  | { type: "part"; id: string }
  | { type: "key"; key: string }
  /** The mouth of a channel, where it leaves the client code. */
  | { type: "gate"; via: "socket" | "http" }
  | { type: "exit"; id: string; via: "socket" | "http" };

export const placeId = (p: Place): string => {
  switch (p.type) {
    case "element":
      return `element:${p.key}`;
    case "part":
      return `part:${p.id}`;
    case "key":
      return `key:${p.key}`;
    case "gate":
      return `gate:${p.via}`;
    case "exit":
      return `exit:${p.id}`;
  }
};

/** An event at a place. */
export type Beat = {
  id: string;
  /** Shown time. */
  time: number;
  /** Real time, in ms since the epoch. */
  real: number;
  place: Place;
  /** What happened: the step's name, the input's action, the function. */
  label: string;
  source: "input" | "step" | "callOut" | "callBack" | "storage";
};

/** A movement between two places that the recording links. */
export type Leg = {
  id: string;
  kind: "write" | "remove" | "read" | "call";
  from: Place;
  to: Place;
  /** Shown times. */
  start: number;
  end: number;
  realStart: number;
  realEnd: number;
  label: string;
  /** The recorded link, said plainly. */
  link: string;
  /** For a call. */
  call?: {
    via: "socket" | "http";
    exit: string;
    /** Whether it leaves: false for a later result of a query. */
    out: boolean;
    failed: boolean;
  };
};

/** Two beats in a row with no recorded link: only next in time. */
export type Then = { id: string; from: Place; to: Place; time: number };

/**
 * The stretch from real time to shown time: a piecewise linear map through
 * `(real[i], shown[i])`, the identity shifted by the last offset past the
 * ends. Beats at the same real time get their own shown times; any other
 * event at that time maps to the first of them.
 */
export type Warp = { real: number[]; shown: number[] };

export const NO_WARP: Warp = { real: [], shown: [] };

/** The shown time of a real time. */
export function shownOf(w: Warp, t: number): number {
  const { real, shown } = w;
  const n = real.length;
  if (n === 0) return t;
  if (t <= real[0]) return t + (shown[0] - real[0]);
  if (t >= real[n - 1]) return t + (shown[n - 1] - real[n - 1]);
  // The last index with real[i] <= t, then the first of its ties.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (real[mid] <= t) lo = mid;
    else hi = mid;
  }
  if (real[lo] === t) {
    while (lo > 0 && real[lo - 1] === t) lo--;
    return shown[lo];
  }
  // Between real[lo] (its last tie) and real[hi].
  let a = lo;
  while (a + 1 < n && real[a + 1] === real[lo]) a++;
  const k = (t - real[a]) / (real[hi] - real[a]);
  return shown[a] + k * (shown[hi] - shown[a]);
}

/** The real time of a shown time. */
export function realOf(w: Warp, s: number): number {
  const { real, shown } = w;
  const n = real.length;
  if (n === 0) return s;
  if (s <= shown[0]) return s - (shown[0] - real[0]);
  if (s >= shown[n - 1]) return s - (shown[n - 1] - real[n - 1]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (shown[mid] <= s) lo = mid;
    else hi = mid;
  }
  const k = (s - shown[lo]) / Math.max(shown[hi] - shown[lo], 1e-9);
  return real[lo] + k * (real[hi] - real[lo]);
}

/** The stretched stretches of a warp, for the time track: real and shown. */
export function stretches(
  w: Warp,
): { shownStart: number; shownEnd: number; real: number }[] {
  const out: { shownStart: number; shownEnd: number; real: number }[] = [];
  let open: { shownStart: number; realStart: number; i: number } | null = null;
  for (let i = 1; i < w.real.length; i++) {
    const stretched =
      w.shown[i] - w.shown[i - 1] > w.real[i] - w.real[i - 1] + 0.5;
    if (stretched && !open)
      open = { shownStart: w.shown[i - 1], realStart: w.real[i - 1], i };
    if (!stretched && open) {
      out.push({
        shownStart: open.shownStart,
        shownEnd: w.shown[i - 1],
        real: w.real[i - 1] - open.realStart,
      });
      open = null;
    }
  }
  if (open) {
    const n = w.real.length - 1;
    out.push({
      shownStart: open.shownStart,
      shownEnd: w.shown[n],
      real: w.real[n] - open.realStart,
    });
  }
  return out;
}

/** A storage change of the browser feed, as the stage keeps it. */
export type StorageChange = {
  id: string;
  time: number;
  area: "local" | "session";
  op: "set" | "remove" | "clear";
  key: string;
};

/** A call of the page, as the browser feed records it. */
export type CallRecord = {
  id: string;
  time: number;
  endTime: number | null;
  identifier: string;
  udfType: string;
  transport: "socket" | "http";
  requestEventId: string | null;
  responseEventId: string | null;
  ok: boolean;
};

/** One thing that happened, before the stretch, in recorded order. */
type Raw = {
  id: string;
  real: number;
  place: Place;
  label: string;
  source: Beat["source"];
  /** At least `ms` of shown time after the beat `id`. */
  after?: { id: string; ms: number };
};

/**
 * The beats, legs and "thens" of a model, and the stretch; the model's own
 * times are real. `model.steps` and the inputs of `model.elements` are read
 * in time order, with ties in recorded order.
 */
export function derivePaths(
  model: StageModel,
  storage: StorageChange[],
  calls: CallRecord[],
): { beats: Beat[]; legs: Leg[]; thens: Then[]; warp: Warp } {
  const raws: Raw[] = [];
  /** Legs with real times; shown times are filled in below. */
  const legs: (Omit<Leg, "start" | "end"> & {
    startId: string;
    endId: string;
  })[] = [];

  for (const element of model.elements)
    for (const use of element.uses)
      raws.push({
        id: use.id,
        real: use.time,
        place: { type: "element", key: element.key },
        label: use.action,
        source: "input",
      });

  // The keys that hold a value at a time, for reads.
  const holds = (key: string, t: number) =>
    [...model.local, ...model.session].some(
      (s) =>
        s.key === key &&
        s.held.some((h) => h.from <= t && (h.to === null || h.to > t)),
    );

  // Storage steps to the storage events of their keys. A change is linked
  // to the earliest step of its key and kind since the key's previous
  // change: a second remove of a key already gone changes nothing.
  const changes = storage.filter((c) => c.op !== "clear");
  const used = new Set<string>();
  const afterOf = new Map<string, { id: string; ms: number }>();
  for (const step of model.steps) {
    raws.push({
      id: step.id,
      real: step.time,
      place: { type: "part", id: step.part },
      label: step.step,
      source: "step",
    });
    const key = step.storageKey;
    if (key === null) continue;
    if (step.step === "storage.read") {
      if (step.detail.found === true && holds(key, step.time))
        legs.push({
          id: `leg:${step.id}`,
          kind: "read",
          from: { type: "key", key },
          to: { type: "part", id: step.part },
          realStart: step.time,
          realEnd: step.time,
          label: "read",
          link: `the step names the key ${key}`,
          startId: step.id,
          endId: step.id,
        });
      continue;
    }
    const op =
      step.step === "storage.write"
        ? "set"
        : step.step === "storage.remove"
          ? "remove"
          : null;
    if (op === null) continue;
    const change = changes.find(
      (c) => c.key === key && c.time >= step.time && !used.has(c.id),
    );
    if (!change || change.op !== op) continue;
    // Not linked when an earlier step of this kind already took it.
    used.add(change.id);
    afterOf.set(change.id, { id: step.id, ms: STORE_MIN_MS });
    legs.push({
      id: `leg:${step.id}`,
      kind: op === "set" ? "write" : "remove",
      from: { type: "part", id: step.part },
      to: { type: "key", key },
      realStart: step.time,
      realEnd: change.time,
      label: op === "set" ? "write" : "remove",
      link: `the step names ${key}; the next change of that key is this ${op}`,
      startId: step.id,
      endId: change.id,
    });
  }
  for (const c of changes)
    if (used.has(c.id))
      raws.push({
        id: c.id,
        real: c.time,
        place: { type: "key", key: c.key },
        label: c.op,
        source: "storage",
        after: afterOf.get(c.id),
      });

  // Calls: out on their request, back on their response.
  const flights = new Map<string, Flight>(model.flights.map((f) => [f.id, f]));
  for (const call of calls) {
    const request = call.requestEventId
      ? flights.get(call.requestEventId)
      : undefined;
    if (!request) continue;
    const via = request.via;
    const exit = request.exit;
    const response =
      call.responseEventId && call.responseEventId !== call.requestEventId
        ? flights.get(call.responseEventId)
        : undefined;
    const end =
      via === "http" ? request.endTime : (response?.time ?? call.endTime);
    if (end === null || end === undefined) continue;
    // A later result of a query: the call's time is not its request's.
    const out = Math.abs(call.time - request.time) < 1;
    const name = call.identifier;
    const outId = `${call.id}:out`;
    const backId = `${call.id}:back`;
    if (out)
      raws.push({
        id: outId,
        real: request.time,
        place: { type: "gate", via },
        label: name,
        source: "callOut",
      });
    raws.push({
      id: backId,
      real: end,
      place: { type: "gate", via },
      label: name,
      source: "callBack",
      after: out ? { id: outId, ms: CALL_MIN_MS } : undefined,
    });
    legs.push({
      id: `leg:${call.id}`,
      kind: "call",
      from: { type: "gate", via },
      to: { type: "exit", id: exit, via },
      realStart: out ? request.time : call.time,
      realEnd: end,
      label: name,
      link: out
        ? `the call names its request (${request.id}) and its response`
        : `a later result of the query: the call names its response`,
      startId: out ? outId : backId,
      endId: backId,
      call: { via, exit, out, failed: !call.ok },
    });
  }

  // In time order, ties in recorded order (the sort is stable).
  raws.sort((a, b) => a.real - b.real);

  // The stretch: consecutive beats at least BEAT_MS apart.
  const shownById = new Map<string, number>();
  const warp: Warp = { real: [], shown: [] };
  let prevReal = -Infinity;
  let prevShown = -Infinity;
  let offset = 0;
  for (const r of raws) {
    let s = r.real + offset;
    if (prevShown > -Infinity) {
      const gap = r.real - prevReal;
      s = prevShown + Math.max(gap, BEAT_MS);
      const after = r.after && shownById.get(r.after.id);
      if (after !== undefined && after !== null && r.after)
        s = Math.max(s, after + r.after.ms);
      offset = s - r.real;
    }
    shownById.set(r.id, s);
    warp.real.push(r.real);
    warp.shown.push(s);
    prevReal = r.real;
    prevShown = s;
  }
  // The map starts unshifted: shown = real before the first beat.
  if (warp.shown.length > 0) {
    const first = warp.shown[0] - warp.real[0];
    for (let i = 0; i < warp.shown.length; i++) warp.shown[i] -= first;
    for (const [k, v] of shownById) shownById.set(k, v - first);
  }

  const beats: Beat[] = raws.map((r) => ({
    id: r.id,
    time: shownById.get(r.id)!,
    real: r.real,
    place: r.place,
    label: r.label,
    source: r.source,
  }));

  const shownLegs: Leg[] = legs.map(({ startId, endId, ...leg }) => {
    const start = shownById.get(startId) ?? shownOf(warp, leg.realStart);
    const end = shownById.get(endId) ?? shownOf(warp, leg.realEnd);
    return { ...leg, start, end: Math.max(end, start + LEG_MIN_MS) };
  });

  // "Then": consecutive beats of the chain (inputs, steps, calls) at
  // different places, close in real time, that no leg joins.
  const joined = new Set(
    shownLegs.map((l) => `${placeId(l.from)}>${placeId(l.to)}`),
  );
  const thens: Then[] = [];
  let prev: Beat | null = null;
  for (const b of beats) {
    if (b.source === "storage") continue;
    if (
      prev &&
      b.real - prev.real <= THEN_GAP_MS &&
      placeId(prev.place) !== placeId(b.place) &&
      !(prev.place.type === "gate" && b.place.type === "gate") &&
      !joined.has(`${placeId(prev.place)}>${placeId(b.place)}`) &&
      !joined.has(`${placeId(b.place)}>${placeId(prev.place)}`)
    )
      thens.push({
        id: `then:${b.id}`,
        from: prev.place,
        to: b.place,
        time: b.time,
      });
    prev = b;
  }

  return { beats, legs: shownLegs, thens, warp };
}

/** A leg at a time: how far along it is, from 0 to 1. */
export type LegAt = {
  leg: Leg;
  /** 0 at `from`, 1 at `to`; a call goes out to 1 and back to 0. */
  along: number;
  phase: "out" | "waiting" | "in" | "move";
};

/** The legs on their way at shown time `t`. */
export function legsAt(legs: Leg[], t: number): LegAt[] {
  const out: LegAt[] = [];
  for (const leg of legs) {
    if (t < leg.start || t > leg.end) continue;
    const span = leg.end - leg.start;
    const k = (t - leg.start) / Math.max(span, 1e-9);
    if (leg.kind !== "call") {
      out.push({ leg, along: ease(k), phase: "move" });
      continue;
    }
    // Out over the first part (or not at all), wait, back over the last.
    const travel = Math.min(span / (leg.call!.out ? 2.4 : 1), 700);
    const dt = t - leg.start;
    if (leg.call!.out && dt < travel)
      out.push({ leg, along: ease(dt / travel), phase: "out" });
    else if (leg.end - t > travel)
      out.push({ leg, along: 1, phase: "waiting" });
    else if (leg.call!.failed && leg.call!.out)
      out.push({ leg, along: 1, phase: "waiting" });
    else
      out.push({
        leg,
        along: ease((leg.end - t) / travel),
        phase: "in",
      });
  }
  return out;
}

const ease = (k: number) => {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
};

/** The path fields of a model before any path is derived. */
export const NO_PATHS: Pick<
  StageModel,
  "beats" | "legs" | "thens" | "warp" | "callFlights"
> = {
  beats: [],
  legs: [],
  thens: [],
  warp: NO_WARP,
  callFlights: new Set(),
};

/**
 * The model with its paths, and every time in it moved to shown time. An
 * event that is a beat takes the beat's own shown time, so that ties keep
 * their order; any other time goes through the warp.
 */
export function withPaths(
  model: StageModel,
  storage: StorageChange[],
  calls: CallRecord[],
): StageModel {
  const { beats, legs, thens, warp } = derivePaths(model, storage, calls);
  const byId = new Map(beats.map((b) => [b.id, b.time]));
  const w = (t: number) => shownOf(warp, t);
  const at = (id: string | null | undefined, t: number) =>
    (id ? byId.get(id) : undefined) ?? w(t);
  const slots = (list: StageModel["local"]) =>
    list.map((slot) => ({
      ...slot,
      held: slot.held.map((h) => ({
        ...h,
        from: at(h.eventId, h.from),
        to: h.to === null ? null : at(h.toEventId, h.to),
      })),
    }));
  const callFlights = new Set<string>();
  for (const leg of legs) if (leg.call) callFlights.add(leg.id.slice(4));
  // The flights a call stands for: its request and its response.
  const flightIds = new Set<string>();
  for (const call of calls)
    if (callFlights.has(call.id)) {
      if (call.requestEventId) flightIds.add(call.requestEventId);
      if (call.responseEventId) flightIds.add(call.responseEventId);
    }
  return {
    ...model,
    start: w(model.start),
    end: w(model.end),
    locations: model.locations.map((l) => ({ ...l, time: w(l.time) })),
    elements: model.elements.map((e) => ({
      ...e,
      uses: e.uses.map((u) => ({ ...u, time: at(u.id, u.time) })),
    })),
    local: slots(model.local),
    session: slots(model.session),
    cookies: slots(model.cookies),
    flights: model.flights.map((f) => ({
      ...f,
      time: w(f.time),
      endTime: f.endTime === null ? null : w(f.endTime),
    })),
    steps: model.steps.map((s) => ({ ...s, time: at(s.id, s.time) })),
    sockets: model.sockets.map((s) => ({
      ...s,
      open: w(s.open),
      close: s.close === null ? null : w(s.close),
    })),
    beats,
    legs,
    thens,
    warp,
    callFlights: flightIds,
  };
}
