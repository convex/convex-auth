/**
 * Reads the browser feed of an explorer timeline (`@convex-dev/explorer`
 * with `--page`) into what the stage shows (`stage/model.ts`): the elements
 * the person used, what the storage and the cookies held, the messages of
 * the WebSocket and of HTTP, and the tokens by their secret labels.
 *
 * Nothing here is derived. A message goes to the exit its URL names; a
 * storage key holds a value from the event that set it until the event that
 * replaced or removed it.
 *
 * @module
 */
import type {
  ElementUse,
  Exit,
  Flight,
  Held,
  PageElement,
  SecretInfo,
  Slot,
  StageModel,
} from "../stage/model.ts";

type Event = { kind: string; id?: string; time?: number } & Record<
  string,
  unknown
>;

/** Messages closer than this in time are one burst, drawn stacked. */
const BURST_MS = 400;

/** What a project says about the outside of the browser. */
export type StageLabels = {
  /** The exit of the Convex deployment. */
  backend: string;
  /** The exit of the server of the page itself. */
  pageServer: string;
  /** The client code, left to right: the app's, the auth client, the data client. */
  client: [string, string, string];
};

export const DEFAULT_LABELS: StageLabels = {
  backend: "Backend",
  pageServer: "Page server",
  client: ["App code", "Auth client", "Data client"],
};

/** Every `{ $secret }` label inside a value. */
export function secretsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) secretsIn(v, out);
  } else if (value !== null && typeof value === "object") {
    const s = (value as { $secret?: unknown }).$secret;
    if (typeof s === "string") {
      if (!out.includes(s)) out.push(s);
    } else {
      for (const v of Object.values(value)) secretsIn(v, out);
    }
  }
  return out;
}

const origin = (url: unknown) => {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
};
const pathOf = (url: unknown) => {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
};

/** A builder of slots, keyed, that keeps each key's values in order. */
class Slots {
  private readonly byKey = new Map<string, Slot>();
  get list(): Slot[] {
    return [...this.byKey.values()].sort((a, b) => a.order - b.order);
  }
  set(
    key: string,
    name: string,
    eventId: string,
    time: number,
    value: unknown,
  ) {
    const slot = this.slot(key, name);
    this.end(slot, time);
    slot.held.push({
      eventId,
      from: time,
      to: null,
      value,
      secrets: secretsIn(value),
    });
    return slot;
  }
  remove(key: string, time: number) {
    const slot = this.byKey.get(key);
    if (slot) this.end(slot, time);
  }
  clear(time: number) {
    for (const slot of this.byKey.values()) this.end(slot, time);
  }
  private end(slot: Slot, time: number) {
    const last: Held | undefined = slot.held[slot.held.length - 1];
    if (last && last.to === null) last.to = time;
  }
  private slot(key: string, name: string): Slot {
    let slot = this.byKey.get(key);
    if (!slot) {
      slot = { key, name, order: this.byKey.size, held: [] };
      this.byKey.set(key, slot);
    }
    return slot;
  }
}

/** What an element is called on the stage. */
function elementLabel(target: Record<string, unknown>): string {
  const text = target.text as string | null;
  if (text) return text;
  for (const field of ["name", "id", "autocomplete", "type"] as const) {
    const v = target[field];
    if (typeof v === "string" && v) return v;
  }
  return String(target.tag ?? "element");
}

/** Builds what the stage shows from the events of a recording. */
export function stageFromEvents(
  events: Event[],
  labels: StageLabels = DEFAULT_LABELS,
): StageModel {
  const recording = events.find((e) => e.kind === "recording");
  const deployment = origin(recording?.deploymentUrl);
  const page = (recording?.page as string | undefined) ?? null;
  const pageOrigin = origin(page);

  const exits = new Map<string, Exit>();
  const addExit = (exit: Exit) => {
    if (!exits.has(exit.id)) exits.set(exit.id, exit);
  };
  addExit({
    id: "backend",
    label: labels.backend,
    host: deployment ?? "",
    known: true,
  });
  addExit({
    id: "page",
    label: labels.pageServer,
    host: pageOrigin ?? "",
    known: true,
  });
  const exitOf = (url: unknown): string => {
    const o = origin(url);
    if (o !== null && o === deployment) return "backend";
    if (o === null || o === pageOrigin) return "page";
    const host = new URL(o).host;
    addExit({ id: `site:${host}`, label: host, host: o, known: false });
    return `site:${host}`;
  };

  const counts: Record<string, number> = {};
  const elements = new Map<string, PageElement>();
  const local = new Slots();
  const session = new Slots();
  const cookies = new Slots();
  const cookieAttrs = new Map<string, Record<string, unknown>>();
  const flights: Flight[] = [];
  const locations: StageModel["locations"] = [];
  const secrets = new Map<string, SecretInfo>();
  const sockets = new Map<
    string,
    { id: string; open: number; close: number | null }
  >();
  let start = Infinity;
  let end = -Infinity;

  const sorted = events
    .filter((e) => typeof e.time === "number")
    .slice()
    .sort((a, b) => (a.time as number) - (b.time as number));

  for (const e of sorted) {
    const time = e.time as number;
    const id = String(e.id ?? "");
    switch (e.kind) {
      case "page": {
        const url = String(e.url);
        if (e.event === "navigated" && url !== "about:blank")
          locations.push({ time, path: pathOf(url) });
        break;
      }
      case "input": {
        const target = (e.target ?? {}) as Record<string, unknown>;
        const key = String(target.selector ?? target.id ?? id);
        let element = elements.get(key);
        if (!element) {
          element = {
            key,
            label: elementLabel(target),
            tag: String(target.tag ?? ""),
            type: (target.type as string | null) ?? null,
            order: elements.size,
            uses: [],
          };
          elements.set(key, element);
        }
        const use: ElementUse = {
          id,
          time,
          action: e.action as ElementUse["action"],
          value: (e.value as string | null) ?? null,
          rect: (target.rect as ElementUse["rect"]) ?? null,
          viewport: (target.viewport as ElementUse["viewport"]) ?? null,
        };
        element.uses.push(use);
        break;
      }
      case "storage": {
        const slots = e.area === "session" ? session : local;
        if (e.op === "set")
          slots.set(String(e.key), String(e.key), id, time, e.value);
        else if (e.op === "remove") slots.remove(String(e.key), time);
        else slots.clear(time);
        break;
      }
      case "cookie": {
        const key = `${e.name}|${e.domain}|${e.path}`;
        if (e.op === "remove") cookies.remove(key, time);
        else {
          cookies.set(key, String(e.name), id, time, e.value);
          cookieAttrs.set(key, {
            domain: e.domain,
            path: e.path,
            httpOnly: e.httpOnly,
            secure: e.secure,
            sameSite: e.sameSite,
            expires: e.expires,
          });
        }
        break;
      }
      case "socket": {
        const socketId = String(e.socketId);
        if (e.direction === "open") {
          sockets.set(socketId, { id: socketId, open: time, close: null });
          break;
        }
        if (e.direction === "close") {
          const s = sockets.get(socketId);
          if (s) s.close = time;
          break;
        }
        const message = (e.message ?? {}) as Record<string, unknown>;
        flights.push({
          id,
          via: "socket",
          exit: "backend",
          direction: e.direction === "sent" ? "out" : "in",
          time,
          label: String(e.type),
          endTime: null,
          status: null,
          failed: false,
          secrets: secretsIn(message),
          detail: { socket: socketId, type: e.type, ...message },
          stack: 0,
        });
        break;
      }
      case "http": {
        const request = e.request as { path: string; args: unknown } | null;
        const response = e.response as Record<string, unknown> | null;
        flights.push({
          id,
          via: "http",
          exit: exitOf(e.url),
          direction: "out",
          time,
          label: `${e.method} ${request?.path ?? pathOf(e.url)}`,
          endTime: (e.endTime as number | null) ?? null,
          status: (e.status as number | null) ?? null,
          failed: e.failure !== null && e.failure !== undefined,
          secrets: secretsIn([request, response]),
          detail: {
            url: e.url,
            type: e.resourceType,
            status: e.status,
            failure: e.failure,
            ...(request ? { request } : {}),
            ...(response ? { response } : {}),
          },
          stack: 0,
        });
        break;
      }
      case "secret": {
        secrets.set(id, {
          id,
          type: e.type as SecretInfo["type"],
          claims: (e.claims as Record<string, unknown> | null) ?? null,
          rows: [],
        });
        break;
      }
      case "secretLink": {
        const s = secrets.get(String(e.secret));
        const row = `${e.component ? `${e.component}/` : ""}${e.table}`;
        if (s && !s.rows.includes(row)) s.rows.push(row);
        break;
      }
      default:
        continue;
    }
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.kind !== "secretLink") {
      start = Math.min(start, time);
      end = Math.max(end, time);
    }
  }
  if (recording && typeof recording.time === "number")
    start = Math.min(start, recording.time);
  for (const f of flights)
    if (f.endTime !== null) end = Math.max(end, f.endTime);

  // Messages of a burst stack up rather than draw as one.
  const lastOf = new Map<string, Flight[]>();
  for (const f of flights.sort((a, b) => a.time - b.time)) {
    const lane = `${f.via}:${f.direction}`;
    const recent = (lastOf.get(lane) ?? []).filter(
      (g) => f.time - g.time < BURST_MS,
    );
    const used = new Set(recent.map((g) => g.stack));
    let stack = 0;
    while (used.has(stack)) stack++;
    f.stack = stack;
    recent.push(f);
    lastOf.set(lane, recent);
  }

  const cookieList = cookies.list;
  for (const c of cookieList) c.attrs = cookieAttrs.get(c.key);
  if (!Number.isFinite(start)) start = end = 0;

  return {
    start,
    end: Math.max(start, end),
    locations,
    elements: [...elements.values()],
    local: local.list,
    session: session.list,
    cookies: cookieList,
    flights,
    exits: [...exits.values()],
    secrets,
    sockets: [...sockets.values()],
    counts,
    page,
  };
}
