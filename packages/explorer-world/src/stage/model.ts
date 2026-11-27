/**
 * What the stage shows, and how it looks at a time.
 *
 * The browser feed of a recording becomes a {@link StageModel}
 * (`adapters/browserStage.ts`): the page's elements that were used, what
 * localStorage and the cookies held and when, and each message that left or
 * came back over the WebSocket or HTTP. {@link stageAt} gives the state of
 * everything at one time, as a pure function of that time: dragging the time
 * handle back and forth shows the same thing at the same time, in both
 * directions.
 *
 * Times are shown times (`paths.ts`): the times of the recording, in ms
 * since the epoch, with bursts stretched so that consecutive steps are far
 * enough apart to follow; `model.warp` maps between the two. Each movement
 * is drawn over {@link TRAVEL_MS} from the moment it happened, so a message
 * that left at `t` is on its way from `t` to `t + TRAVEL_MS`. Nothing moves
 * that the recording does not show happening.
 *
 * @module
 */

import {
  BEAT_LIT_MS,
  NO_WARP,
  THEN_MS,
  legsAt,
  type Beat,
  type Leg,
  type LegAt,
  type Then,
  type Warp,
} from "./paths.ts";

/** How long a movement is drawn, in ms. */
export const TRAVEL_MS = 700;
/** How long a used element stays lit, in ms. */
export const LIT_MS = 1400;
/** How long an object takes to land in storage or to leave it, in ms. */
export const LAND_MS = 600;

/** A `{ $secret }` label of the recording, in place of a token. */
export type SecretInfo = {
  id: string;
  type: "jwt" | "opaque";
  claims: Record<string, unknown> | null;
  /** Rows of the server the token belongs to, as `component/table`. */
  rows: string[];
};

/** An element of the page that the person used. */
export type PageElement = {
  key: string;
  /** What it is called: the text of a button, the name of a field. */
  label: string;
  tag: string;
  type: string | null;
  /** In order of first use. */
  order: number;
  uses: ElementUse[];
};

export type ElementUse = {
  id: string;
  time: number;
  action: "click" | "type" | "submit" | "key";
  /** The recorded value: text kept, "[redacted]", or null (a password). */
  value: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number } | null;
};

/** One value a key held, from `from` until `to` (null: still). */
export type Held = {
  eventId: string;
  from: number;
  to: number | null;
  /** The event that ended it, or null. */
  toEventId?: string | null;
  /** The value as recorded: tokens are `{ $secret }`. */
  value: unknown;
  /** The tokens in the value. */
  secrets: string[];
};

/** A key of localStorage or sessionStorage, or a cookie. */
export type Slot = {
  key: string;
  /** What it is called: the storage key, or the cookie's name. */
  name: string;
  /** In order of first appearance. */
  order: number;
  held: Held[];
  /** For a cookie: its attributes, from the last time it was set. */
  attrs?: Record<string, unknown>;
};

/** Where a message goes: the backend, the page's server, another site. */
export type ExitId = string;

export type Exit = {
  id: ExitId;
  label: string;
  /** The host it stands for, for the inspector. */
  host: string;
  /** Present from the start, or seen in the recording. */
  known: boolean;
};

/** A message that left the browser or came back. */
export type Flight = {
  id: string;
  via: "socket" | "http";
  exit: ExitId;
  /** "out": from the browser to the exit; "in": back. */
  direction: "out" | "in";
  /** When it left (out) or arrived (in). */
  time: number;
  /** What it is: a socket message type, or "GET /path". */
  label: string;
  /** For an HTTP request: when its response came back, or null. */
  endTime: number | null;
  /** For an HTTP request: its status or failure. */
  status: number | null;
  failed: boolean;
  /** The tokens it carried. */
  secrets: string[];
  /** The fields to show in the inspector. */
  detail: Record<string, unknown>;
  /**
   * Its place in a burst: how many messages of the same connection and
   * direction left shortly before it and are still on their way. Drawn
   * stacked, so that a burst does not draw as one object.
   */
  stack: number;
};

/**
 * A step the client code reported from the page: which part of it ran
 * (a module of the structure map) and what it did.
 */
export type PageStep = {
  id: string;
  time: number;
  /** The module that ran, e.g. a module id of the structure map. */
  part: string;
  step: string;
  detail: Record<string, unknown>;
  /** For a storage step: the storage key it names (key and namespace). */
  storageKey: string | null;
};

/** Where the page was, from a time on. */
export type Location = { time: number; path: string };

export type StageModel = {
  /** The first and the last time of the recording. */
  start: number;
  end: number;
  /** The page's address over time. */
  locations: Location[];
  elements: PageElement[];
  local: Slot[];
  session: Slot[];
  cookies: Slot[];
  flights: Flight[];
  /** The steps the client code reported, in time order. */
  steps: PageStep[];
  exits: Exit[];
  secrets: Map<string, SecretInfo>;
  /** The sockets' open and close times. */
  sockets: { id: string; open: number; close: number | null }[];
  /** Per kind: how many events of the browser feed were read. */
  counts: Record<string, number>;
  /** The page the recorder opened, from its first line. */
  page: string | null;
  /** The path of what the client did (`paths.ts`). */
  beats: Beat[];
  legs: Leg[];
  thens: Then[];
  /** The stretch from real time to the shown time of every field here. */
  warp: Warp;
  /** The messages a call's traveller stands for, not drawn on their own. */
  callFlights: Set<string>;
};

export const EMPTY_MODEL: StageModel = {
  start: 0,
  end: 0,
  locations: [],
  elements: [],
  local: [],
  session: [],
  cookies: [],
  flights: [],
  steps: [],
  exits: [],
  secrets: new Map(),
  sockets: [],
  counts: {},
  page: null,
  beats: [],
  legs: [],
  thens: [],
  warp: NO_WARP,
  callFlights: new Set(),
};

// ------------------------------------------------------------ at a time --

/** A movement in flight: where it is along its way, from 0 to 1. */
export type FlightAt = {
  flight: Flight;
  /** 0 at the browser, 1 at the exit. */
  along: number;
  /** "out" on its way there, "in" on its way back, "waiting" at the exit. */
  phase: "out" | "in" | "waiting";
};

/** A slot's object at a time. */
export type SlotAt = {
  slot: Slot;
  held: Held;
  /** 0 when it has just landed or is leaving far, 1 at rest. */
  settled: number;
  /** Whether it is leaving (removed or replaced). */
  leaving: boolean;
};

export type StageAt = {
  time: number;
  path: string | null;
  /** The elements used so far, each with how lit it is now (0 to 1). */
  elements: { element: PageElement; lit: number; last: ElementUse | null }[];
  local: SlotAt[];
  session: SlotAt[];
  cookies: SlotAt[];
  flights: FlightAt[];
  /** Per exit, whether something is there now. */
  busyExits: Set<ExitId>;
  socketOpen: boolean;
  /** Per part of the client code that reported a step: how lit, and its last step. */
  parts: Map<string, { lit: number; step: PageStep }>;
  /** Per storage key a step just read or wrote: how lit, and the step. */
  keys: Map<string, { lit: number; step: PageStep }>;
  /** The legs on their way. */
  legs: LegAt[];
  /** The "thens" drawn now, each with how faded it is (1 just drawn). */
  thens: { then: Then; fresh: number }[];
  /** The beats just happened, each with how lit (1 just now). */
  beats: { beat: Beat; lit: number }[];
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The objects of the slots at `t`: those held, landing or leaving. */
function slotsAt(slots: Slot[], t: number): SlotAt[] {
  const out: SlotAt[] = [];
  for (const slot of slots) {
    for (const held of slot.held) {
      if (held.from > t) break;
      if (held.to === null || t < held.to) {
        out.push({
          slot,
          held,
          settled: clamp01((t - held.from) / LAND_MS),
          leaving: false,
        });
      } else if (t < held.to + LAND_MS) {
        out.push({
          slot,
          held,
          settled: 1 - clamp01((t - held.to) / LAND_MS),
          leaving: true,
        });
      }
    }
  }
  return out;
}

/** The state of the stage at time `t`. */
export function stageAt(model: StageModel, t: number): StageAt {
  let path: string | null = null;
  for (const l of model.locations) if (l.time <= t) path = l.path;

  const elements: StageAt["elements"] = [];
  for (const element of model.elements) {
    let last: ElementUse | null = null;
    for (const use of element.uses) if (use.time <= t) last = use;
    if (last === null) continue;
    elements.push({
      element,
      last,
      lit: 1 - clamp01((t - last.time) / LIT_MS),
    });
  }

  const flights: FlightAt[] = [];
  const busyExits = new Set<ExitId>();
  for (const flight of model.flights) {
    if (flight.time > t) continue;
    if (model.callFlights.has(flight.id)) continue;
    const dt = t - flight.time;
    if (flight.via === "socket") {
      if (dt > TRAVEL_MS) continue;
      const k = dt / TRAVEL_MS;
      flights.push({
        flight,
        along: flight.direction === "out" ? k : 1 - k,
        phase: flight.direction,
      });
      if (k > 0.85 && flight.direction === "out") busyExits.add(flight.exit);
      continue;
    }
    // HTTP: out, wait at the exit until the response, back.
    const back = Math.max(flight.endTime ?? Infinity, flight.time + TRAVEL_MS);
    if (dt <= TRAVEL_MS) {
      flights.push({ flight, along: dt / TRAVEL_MS, phase: "out" });
    } else if (t < back) {
      flights.push({ flight, along: 1, phase: "waiting" });
      busyExits.add(flight.exit);
    } else if (t <= back + TRAVEL_MS && !flight.failed) {
      flights.push({
        flight,
        along: 1 - (t - back) / TRAVEL_MS,
        phase: "in",
      });
    }
  }

  const parts = new Map<string, { lit: number; step: PageStep }>();
  const keys = new Map<string, { lit: number; step: PageStep }>();
  for (const step of model.steps) {
    if (step.time > t) break;
    const lit = 1 - clamp01((t - step.time) / LIT_MS);
    parts.set(step.part, { lit, step });
    if (step.storageKey !== null) keys.set(step.storageKey, { lit, step });
  }

  const thens: StageAt["thens"] = [];
  for (const then of model.thens) {
    if (then.time > t) break;
    if (t - then.time < THEN_MS)
      thens.push({ then, fresh: 1 - (t - then.time) / THEN_MS });
  }
  const beats: StageAt["beats"] = [];
  for (const beat of model.beats) {
    if (beat.time > t) break;
    if (t - beat.time < BEAT_LIT_MS)
      beats.push({ beat, lit: 1 - (t - beat.time) / BEAT_LIT_MS });
  }

  const socketOpen = model.sockets.some(
    (s) => s.open <= t && (s.close === null || s.close > t),
  );

  return {
    time: t,
    path,
    elements,
    local: slotsAt(model.local, t),
    session: slotsAt(model.session, t),
    cookies: slotsAt(model.cookies, t),
    flights,
    busyExits,
    socketOpen,
    parts,
    keys,
    legs: legsAt(model.legs, t),
    thens,
    beats,
  };
}
