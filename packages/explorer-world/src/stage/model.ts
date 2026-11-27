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
 * Times are those of the recording, in ms since the epoch. A real request
 * takes milliseconds, too short to see; each movement is drawn over
 * {@link TRAVEL_MS} from the moment it happened, so a message that left at
 * `t` is on its way from `t` to `t + TRAVEL_MS`. Nothing moves that the
 * recording does not show happening.
 *
 * @module
 */

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
  exits: Exit[];
  secrets: Map<string, SecretInfo>;
  /** The sockets' open and close times. */
  sockets: { id: string; open: number; close: number | null }[];
  /** Per kind: how many events of the browser feed were read. */
  counts: Record<string, number>;
  /** The page the recorder opened, from its first line. */
  page: string | null;
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
  exits: [],
  secrets: new Map(),
  sockets: [],
  counts: {},
  page: null,
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
  };
}
