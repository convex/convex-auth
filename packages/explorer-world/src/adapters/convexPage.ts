/**
 * Reads the browser feed of an explorer timeline (`@convex-dev/explorer`
 * with `--page`): the pages, the calls they made and the runs those link to,
 * the secrets that travelled and the rows they are, what the page stored,
 * its inputs and navigations, and the steps of the scenario that drove it.
 *
 * Nothing here is derived. A call links to a run only where the recorder
 * linked it (`runId`); a call it could not link stays unlinked, with the runs
 * it may be. A token is followed through its `$secret` label: the message
 * that carried it, the storage that held it, and the row `secretLink` says
 * it is.
 */
import type { Part } from "../model/graph.ts";
import type {
  Cargo,
  Load,
  PageItem,
  PageState,
  Tone,
} from "../model/recording.ts";
import type { Presentation } from "../presentation.ts";
import { PLACES } from "./browserPlaces.ts";
import { scalars } from "../model/inside.ts";

type Event = { kind: string; id: string; time: number } & Record<
  string,
  unknown
>;

/** The kinds this module reads. */
export const PAGE_KINDS = new Set([
  "page",
  "input",
  "http",
  "socket",
  "storage",
  "cookie",
  "console",
  "scenario",
  "call",
  "secret",
  "secretLink",
]);

export interface PageFeed {
  /** The pages, and what the recording shows in the browser: elements, storage keys, cookies. */
  pages: Part[];
  /** Per run id: the call of a page that the run answered. */
  calls: Map<
    string,
    {
      page: string;
      transport: string;
      link: string;
      cargoIn: Cargo[];
      cargoOut: Cargo[];
      /** What the request and the response carried: labels and redacted fields. */
      loadIn: Load[];
      loadOut: Load[];
      /** Where the request stands in its page's order of events. */
      order?: { page: string; seq: number };
      /** When the page sent the request and got the response, by the page's clock (ms). */
      sentAt?: number;
      answeredAt?: number;
      /**
       * The module that sent it: the one that reported a `signIn.call` of
       * its function when this was the only call of that function from the
       * page before the matching `signIn.return` (matched by bracket).
       */
      sender?: string;
    }
  >;
  items: PageItem[];
  /** When each step of the scenario started. */
  sections: { time: number; text: string }[];
  /** Per kind: events seen and played. */
  counts: Record<string, { seen: number; played: number }>;
  /** Why the events that did not play did not. */
  unplayed: Record<string, string>;
}

/** Every `{ $secret }` label inside a value. */
function secretsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) secretsIn(v, out);
  else if (value && typeof value === "object") {
    const ref = (value as { $secret?: unknown }).$secret;
    if (typeof ref === "string") out.push(ref);
    else for (const v of Object.values(value)) secretsIn(v, out);
  }
  return out;
}

const secretOf = (value: unknown): string | undefined => secretsIn(value)[0];

/** The value the recorder puts in place of a field it hides. */
const REDACTED = "[redacted]";

/**
 * Every token label and every redacted field inside a value, with the field
 * each was in, in the order they appear; a label once.
 */
function loadsIn(
  value: unknown,
  field = "",
  out: { secret?: string; field: string }[] = [],
): { secret?: string; field: string }[] {
  if (value === REDACTED) out.push({ field });
  else if (Array.isArray(value)) for (const v of value) loadsIn(v, field, out);
  else if (value && typeof value === "object") {
    const ref = (value as { $secret?: unknown }).$secret;
    if (typeof ref === "string") {
      if (!out.some((l) => l.secret === ref)) out.push({ secret: ref, field });
    } else for (const [k, v] of Object.entries(value)) loadsIn(v, k, out);
  }
  return out;
}

export function readPageFeed(
  events: Event[],
  presentation: Presentation,
  resolveTable: (component: string, table: string) => string,
  runIds: Set<string>,
  hasPart: (id: string) => boolean = () => false,
): PageFeed {
  const counts: PageFeed["counts"] = {};
  const count = (kind: string, played: boolean) => {
    counts[kind] ??= { seen: 0, played: 0 };
    counts[kind].seen++;
    if (played) counts[kind].played++;
  };
  const feed = events
    .filter((e) => PAGE_KINDS.has(e.kind) || isPageStep(e))
    .sort((a, b) => a.time - b.time || sequence(a.id) - sequence(b.id));
  const byId = new Map(feed.map((e) => [e.id, e]));

  // Secrets: their type, and the row each one is.
  const secrets = new Map<
    string,
    { type: string; table?: string; row?: string }
  >();
  for (const e of feed) {
    if (e.kind === "secret") secrets.set(e.id, { type: String(e.type) });
  }
  for (const e of feed) {
    if (e.kind !== "secretLink") continue;
    const s = secrets.get(String(e.secret)) ?? { type: "opaque" };
    s.table = resolveTable(String(e.component ?? ""), String(e.table));
    s.row = String(e.documentId);
    secrets.set(String(e.secret), s);
  }
  const cargoOf = (label: string): Cargo | null => {
    const s = secrets.get(label);
    if (!s?.table || !s.row) return null;
    const rule = presentation.cargo?.find(
      (c) => c.table === s.table && (!c.secretType || c.secretType === s.type),
    );
    return {
      table: s.table,
      row: s.row,
      secret: label,
      label: `${rule?.noun ?? `${s.type} secret`} ${label}`,
      ...(rule?.noun ? { noun: rule.noun } : {}),
    };
  };
  const loadOf = (value: unknown): Load[] =>
    loadsIn(value).map((l) => {
      if (l.secret === undefined) return { kind: "redacted", field: l.field };
      const cargo = cargoOf(l.secret);
      return {
        kind: "secret",
        secret: l.secret,
        type: secrets.get(l.secret)?.type ?? "opaque",
        field: l.field,
        ...(cargo ? { cargo } : {}),
      };
    });
  const cargoIn = (value: unknown) =>
    [...new Set(secretsIn(value))]
      .map(cargoOf)
      .filter((c): c is Cargo => c !== null);

  // Pages, and the places in the browser the recording shows.
  const pages = new Map<string, Part>();
  const region =
    presentation.client && hasPart(presentation.client)
      ? presentation.client
      : null;
  const placeOf = (
    id: string,
    kind: string,
    name: string,
    parent: string | null,
    observed: string,
  ) => {
    if (!pages.has(id) && !hasPart(id))
      pages.set(id, {
        id,
        kind,
        name,
        label: name,
        parent,
        source: null,
        facts: [],
        observed,
      });
    return id;
  };
  // A key's store is the area of the first storage event that names it.
  const areaOfKey = new Map<string, string>();
  for (const e of feed)
    if (e.kind === "storage" && typeof e.key === "string")
      if (!areaOfKey.has(e.key)) areaOfKey.set(e.key, String(e.area));
  // A key a step names with a namespace is known by its own name; the
  // namespace (the deployment's address) is in its summary, for the
  // inspector.
  const nameOfKey = new Map<string, { name: string; namespace: string }>();
  for (const e of feed)
    if (isPageStep(e)) {
      const d = (e.detail ?? {}) as Record<string, unknown>;
      if (typeof d.key === "string" && typeof d.namespace === "string")
        nameOfKey.set(`${d.key}_${d.namespace}`, {
          name: d.key,
          namespace: d.namespace,
        });
    }
  const keyOf = (key: string, reporter?: string) => {
    const known = nameOfKey.get(key);
    const area = areaOfKey.get(key);
    const store = area ? PLACES.store(area) : null;
    if (store && region)
      placeOf(
        store,
        "store",
        `${area}Storage`,
        region,
        `The browser's ${area}Storage for the page's origin.`,
      );
    return placeOf(
      PLACES.storageKey(key),
      "storageKey",
      known?.name ?? key,
      store ?? reporter ?? region,
      (store
        ? `A key of ${area}Storage the recording shows.`
        : "A storage key the client library names; no storage event of the recording says which storage holds it.") +
        (known ? ` Stored as ${key} (namespace ${known.namespace}).` : ""),
    );
  };
  // A scenario step names no page: it belongs to the page last seen.
  let lastPage: string | null = null;
  const pageOf = (pageId: unknown) => {
    if (pageId === undefined && lastPage) return lastPage;
    const id = `page:${String(pageId ?? "page")}`;
    lastPage = id;
    if (!pages.has(id)) {
      const first = feed.find(
        (e) =>
          e.kind === "page" &&
          e.pageId === pageId &&
          /^https?:/.test(String(e.url)),
      );
      const host = first
        ? String(first.url).replace(/^[a-z]+:\/\/([^/]+).*$/, "$1")
        : null;
      pages.set(id, {
        id,
        kind: "page",
        name: String(pageId ?? "page"),
        label: host ? `page ${host}` : "page",
        parent: region,
        source: null,
        facts: presentation.client ? [["region", presentation.client]] : [],
        observed: "A page of the app in a browser, as the recording shows it.",
      });
      placeOf(
        PLACES.state(id),
        "pageState",
        "sign-in state",
        id,
        "The page's sign-in state, as its client library reports it.",
      );
    }
    return id;
  };

  const calls: PageFeed["calls"] = new Map();
  // Open sign-in calls, per page and function: who reported it, and the
  // calls of that function the page made since.
  // The sign-in calls the client library reported, and the calls the page
  // made, in the page's own order (the recorder numbers a page's events in
  // one sequence: `p1#24`).
  const signIns: {
    key: string;
    part: string;
    open: number;
    close: number | null;
  }[] = [];
  const pageCalls: { key: string; seq: number; run: string }[] = [];
  const items: PageItem[] = [];
  const sections: PageFeed["sections"] = [];
  const referenced = new Set<string>();
  let lastText = "";
  const item = (
    e: Event,
    kind: string,
    text: string,
    tone: Tone = "normal",
    extra: Partial<PageItem> = {},
  ) => {
    const part = extra.lights?.[0] ?? pageOf(e.pageId);
    // Repeats in a row (a page that loaded twice) show once. A navigation of
    // a recording that tells a new document from a change within one is
    // never a repeat: twice to the same URL is a reload.
    const navigation =
      e.kind === "page" &&
      e.event === "navigated" &&
      e.sameDocument !== undefined;
    if (`${part}|${text}` === lastText && !extra.hold && !navigation)
      return true;
    lastText = `${part}|${text}`;
    items.push({
      time: e.time,
      order: orderOf(e),
      kind,
      part,
      text,
      tone,
      ...extra,
    });
    return true;
  };

  // Recordings made before the recorder told a new document from a change
  // within one (no `sameDocument`) also hold a history update that kept the
  // URL (React Router stamps its state on start, after the load). Such a
  // "navigated" goes to the URL the page is at, and no load follows it,
  // which a reload's does.
  const stayed = new Set<string>();
  {
    const at = new Map<string, string>();
    const pending = new Map<string, Event>();
    for (const e of feed) {
      if (e.kind !== "page") continue;
      const page = String(e.pageId);
      const held = pending.get(page);
      pending.delete(page);
      if (held && e.event !== "load") stayed.add(held.id);
      if (e.event !== "navigated") continue;
      const url = String(e.url);
      if (e.sameDocument === undefined && at.get(page) === url)
        pending.set(page, e);
      at.set(page, url);
    }
    for (const held of pending.values()) stayed.add(held.id);
  }

  // Document loads per page: a client's operation numbers count within one.
  // The recorder can report a load twice (from the page and from the
  // browser); two within LOAD_TWICE_MS are one.
  const loads = new Map<string, { n: number; at: number }>();
  const LOAD_TWICE_MS = 100;
  for (const e of feed) {
    if (e.kind === "page" && e.event === "load") {
      const page = pageOf(e.pageId);
      const was = loads.get(page);
      if (!was || e.time - was.at > LOAD_TWICE_MS)
        loads.set(page, { n: (was?.n ?? 0) + 1, at: e.time });
    }
    if (isPageStep(e)) {
      const part = String(e.part);
      const reporter = hasPart(part) ? part : pageOf(e.pageId);
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      const page = pageOf(e.pageId);
      const lights = [reporter];
      if (typeof detail.key === "string") {
        const key =
          typeof detail.namespace === "string"
            ? `${detail.key}_${detail.namespace}`
            : detail.key;
        lights.push(keyOf(key, reporter));
      }
      const state = stateAfter(presentation, String(e.step), detail);
      if (typeof detail.function === "string") {
        const key = `${page}|${detail.function}`;
        if (e.step === "signIn.call")
          signIns.push({
            key,
            part: reporter,
            open: sequence(e.id),
            close: null,
          });
        else if (e.step === "signIn.return" || e.step === "signIn.throw") {
          const open = signIns.find((b) => b.key === key && b.close === null);
          if (open) open.close = sequence(e.id);
        }
      }
      items.push({
        time: e.time,
        order: orderOf(e),
        kind: "step",
        part: reporter,
        text: stepText(String(e.step), detail),
        tone: state === "error" ? "error" : "normal",
        lights,
        step: String(e.step),
        report: {
          step: String(e.step),
          runsIn: "browser",
          part: String(e.part),
          detail: scalars(detail),
        },
        ...(state ? { state: { holder: PLACES.state(page), state } } : {}),
        ...(typeof detail.function === "string" ? { fn: detail.function } : {}),
        ...(state === "error" && isCode(detail.error)
          ? { code: detail.error }
          : {}),
        ...(typeof detail.op === "number"
          ? {
              op: `${page}|load${loads.get(page)?.n ?? 0}|${detail.op}`,
              opKind:
                typeof detail.opKind === "string" ? detail.opKind : undefined,
              parentOp:
                typeof detail.parentOp === "number"
                  ? `${page}|load${loads.get(page)?.n ?? 0}|${detail.parentOp}`
                  : undefined,
            }
          : {}),
      });
      count("step (page)", true);
      continue;
    }
    switch (e.kind) {
      case "secret":
      case "secretLink":
        count(e.kind, true);
        break;
      case "call": {
        referenced.add(String(e.requestEventId));
        referenced.add(String(e.responseEventId));
        const page = pageOf(e.pageId);
        const request = byId.get(String(e.requestEventId));
        const response = byId.get(String(e.responseEventId));
        const runId =
          typeof e.runId === "string" && runIds.has(e.runId) ? e.runId : null;
        if (runId) {
          count("call", true);
          if (request)
            pageCalls.push({
              key: `${page}|${String(e.identifier)}`,
              seq: sequence(request.id),
              run: runId,
            });
          calls.set(runId, {
            page,
            order: request ? { page, seq: sequence(request.id) } : undefined,
            sentAt: request?.time,
            answeredAt: response?.time,
            transport: String(e.transport),
            link: String(e.link),
            cargoIn: cargoIn(
              request?.kind === "http" ? request.request : request?.message,
            ),
            cargoOut: cargoIn(
              response?.kind === "http" ? response.response : response?.message,
            ),
            // What it carried: the request's arguments, the response's
            // result (the envelope of the message carries none).
            loadIn: loadOf(
              request?.kind === "http"
                ? (request.request as { args?: unknown } | null)?.args
                : (request?.message as { args?: unknown } | undefined)?.args,
            ),
            loadOut: loadOf(
              response?.kind === "http"
                ? (response.response as { value?: unknown } | null)?.value
                : (response?.message as { result?: unknown } | undefined)
                    ?.result,
            ),
          });
        } else {
          const candidates = ((e.candidateRunIds as string[]) ?? []).filter(
            (r) => runIds.has(r),
          );
          count(
            "call",
            item(
              e,
              "call",
              `${String(e.udfType).toLowerCase()} ${String(e.identifier)}: not linked to one run (${String(e.unlinked)})`,
              "normal",
              {
                candidates,
                fn: String(e.identifier),
                callType: String(e.udfType).toLowerCase(),
              },
            ),
          );
        }
        break;
      }
      case "input": {
        const t = (e.target ?? {}) as Record<string, string | null>;
        // A plain short name for the element, never its selector path: its
        // name or id, its text when short, else its tag.
        const text = t.text?.trim();
        const what =
          t.name ??
          t.id ??
          (text && text.length <= 24 ? text : null) ??
          t.tag ??
          "element";
        const page = pageOf(e.pageId);
        const element = placeOf(
          PLACES.element(page, String(t.selector ?? t.tag)),
          "element",
          String(what),
          page,
          "An element of the page the person used, as the recording shows it.",
        );
        const value = typeof e.value === "string" ? ` "${e.value}"` : "";
        const verb: Record<string, string> = {
          click: `clicks "${what}"`,
          type: `types${value || " a hidden value"} into ${what}`,
          submit: "submits the form",
          key: `presses a key in ${what}`,
        };
        count(
          e.kind,
          item(
            e,
            "input",
            verb[String(e.action)] ?? `${String(e.action)} ${what}`,
            "normal",
            {
              lights: [element],
              input: { action: String(e.action), what: String(what) },
            },
          ),
        );
        break;
      }
      case "page": {
        if (stayed.has(e.id)) {
          // Folded into the navigation before it, as a repeat is.
          count(e.kind, true);
          break;
        }
        const path =
          String(e.url).replace(/^[a-z]+:\/\/[^/]+/, "") || String(e.url);
        const blank = /^about:/.test(String(e.url));
        const sentence: Record<string, string> = {
          open: blank
            ? "a browser tab opens"
            : `a browser tab opens on ${path}`,
          navigated: `goes to ${path}`,
          load: `finishes loading ${path}`,
          close: "the tab closes",
        };
        count(
          e.kind,
          item(
            e,
            "page",
            sentence[String(e.event)] ?? `${String(e.event)} ${path}`,
            "normal",
            e.event === "load" && !blank ? { loaded: true } : {},
          ),
        );
        break;
      }
      case "scenario": {
        if (e.status === "start")
          sections.push({ time: e.time, text: String(e.step) });
        const tone: Tone = e.status === "error" ? "error" : "normal";
        count(
          e.kind,
          item(
            e,
            "scenario",
            e.status === "start"
              ? `the scenario: ${String(e.step)}`
              : e.status === "end"
                ? `the scenario step is done: ${String(e.step)}`
                : `the scenario step failed: ${String(e.step)}${e.error ? ` (${String(e.error)})` : ""}`,
            tone,
            e.status === "start"
              ? { scenario: "start", pressed: String(e.step) }
              : { scenario: "end" },
          ),
        );
        break;
      }
      case "storage": {
        const where = `${String(e.area)}Storage ${String(e.key ?? "")}`;
        const key = keyOf(String(e.key ?? ""));
        const gained = secretOf(e.value);
        const lost = secretOf(e.oldValue);
        const gain = gained ? cargoOf(gained) : null;
        const drop = lost ? cargoOf(lost) : null;
        pageOf(e.pageId);
        if (drop)
          items.push({
            time: e.time,
            order: orderOf(e),
            kind: "storage",
            part: key,
            text: `removes ${drop.label} from ${where}`,
            tone: "normal",
            hold: { op: "drop", cargo: drop, where },
            lights: [key],
          });
        if (gain)
          items.push({
            time: e.time,
            order: orderOf(e),
            kind: "storage",
            part: key,
            text: `stores ${gain.label} in ${where}`,
            tone: "normal",
            hold: { op: "gain", cargo: gain, where },
            lights: [key],
          });
        if (!gain && !drop)
          item(e, "storage", `${where}: ${String(e.op)}`, "normal", {
            lights: [key],
          });
        count(e.kind, true);
        break;
      }
      case "console": {
        const level = String(e.level);
        count(
          e.kind,
          item(
            e,
            "console",
            `${level}: ${String(e.text)}`,
            level === "error" ? "error" : "warn",
          ),
        );
        break;
      }
      case "cookie": {
        const cookie = placeOf(
          PLACES.cookie(String(e.name)),
          "cookie",
          String(e.name),
          region ? PLACES.store("cookies") : null,
          "A cookie the recording shows.",
        );
        count(
          e.kind,
          item(
            e,
            "cookie",
            `cookie ${String(e.name)}: ${String(e.op)}`,
            "normal",
            {
              lights: [cookie],
            },
          ),
        );
        break;
      }
      default:
        break;
    }
  }
  // A sign-in call was sent by the module that reported it when it is the
  // only call of that function the page made between the module's
  // signIn.call and signIn.return.
  for (const b of signIns) {
    if (b.close === null) continue;
    const inside = pageCalls.filter(
      (c) => c.key === b.key && c.seq > b.open && c.seq < b.close!,
    );
    const call = inside.length === 1 && calls.get(inside[0].run);
    if (call) call.sender = b.part;
  }
  // Messages and requests play as the calls that refer to them.
  for (const e of feed) {
    if (e.kind === "socket" || e.kind === "http")
      count(e.kind, referenced.has(e.id));
  }
  return {
    pages: [...pages.values()],
    calls,
    items,
    sections,
    counts,
    unplayed: {
      socket:
        "Socket messages that no call refers to (connection, query updates, pings).",
      http: "Requests that no call refers to (the page's own documents and assets).",
    },
  };
}

/** Where an event stands in its page's order: the recorder numbers them `p1#24`. */
const orderOf = (e: { id: string; pageId?: unknown }) =>
  typeof e.pageId === "string" && String(e.id).includes("#")
    ? { page: `page:${e.pageId}`, seq: sequence(e.id) }
    : undefined;

const sequence = (id: string) => Number(String(id).split("#").pop()) || 0;

/** A step the client library reported from the page (it has no run). */
export function isPageStep(e: { kind: string; from?: unknown }): boolean {
  return e.kind === "step" && e.from === "page";
}

/**
 * The page's sign-in state after a step its client library reported, by the
 * presentation's rules, if one matches.
 */
function stateAfter(
  presentation: Presentation,
  step: string,
  detail: Record<string, unknown>,
): PageState | null {
  const rule = presentation.pageStates?.find(
    (r) =>
      r.step === step &&
      Object.entries(r.when ?? {}).every(([k, v]) => detail[k] === v),
  );
  return rule?.state ?? null;
}

/**
 * An error code from the client's fixed list (capitals and underscores),
 * not a message: only that is shown of an error.
 */
const isCode = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(v);

/** The step as one short line: its name, and its detail without secrets. */
function stepText(step: string, detail: Record<string, unknown>): string {
  const shown = Object.entries(detail)
    .filter(([, v]) => typeof v !== "object" || v === null)
    .map(([k, v]) => `${k} ${String(v)}`);
  return shown.length ? `${step} · ${shown.join(", ")}` : step;
}
