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
import type { Cargo, PageItem, Tone } from "../model/recording.ts";
import type { Presentation } from "../presentation.ts";

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

export function readPageFeed(
  events: Event[],
  presentation: Presentation,
  resolveTable: (component: string, table: string) => string,
  runIds: Set<string>,
): PageFeed {
  const counts: PageFeed["counts"] = {};
  const count = (kind: string, played: boolean) => {
    counts[kind] ??= { seen: 0, played: 0 };
    counts[kind].seen++;
    if (played) counts[kind].played++;
  };
  const feed = events
    .filter((e) => PAGE_KINDS.has(e.kind))
    .sort((a, b) => a.time - b.time);
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
    };
  };
  const cargoIn = (value: unknown) =>
    [...new Set(secretsIn(value))]
      .map(cargoOf)
      .filter((c): c is Cargo => c !== null);

  // Pages.
  const pages = new Map<string, Part>();
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
        parent: null,
        source: null,
        facts: presentation.client ? [["region", presentation.client]] : [],
        observed: "A page of the app in a browser, as the recording shows it.",
      });
    }
    return id;
  };

  const calls: PageFeed["calls"] = new Map();
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
    const part = pageOf(e.pageId);
    // Repeats in a row (a page navigating to the same URL twice) show once.
    if (`${part}|${text}` === lastText && !extra.hold) return true;
    lastText = `${part}|${text}`;
    items.push({ time: e.time, kind, part, text, tone, ...extra });
    return true;
  };

  for (const e of feed) {
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
          calls.set(runId, {
            page,
            transport: String(e.transport),
            link: String(e.link),
            cargoIn: cargoIn(
              request?.kind === "http" ? request.request : request?.message,
            ),
            cargoOut: cargoIn(
              response?.kind === "http" ? response.response : response?.message,
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
              },
            ),
          );
        }
        break;
      }
      case "input": {
        const t = (e.target ?? {}) as Record<string, string | null>;
        const what = t.text ?? t.name ?? t.id ?? t.selector ?? t.tag;
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
          ),
        );
        break;
      }
      case "page": {
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
          ),
        );
        break;
      }
      case "storage": {
        const where = `${String(e.area)}Storage ${String(e.key ?? "")}`;
        const gained = secretOf(e.value);
        const lost = secretOf(e.oldValue);
        const gain = gained ? cargoOf(gained) : null;
        const drop = lost ? cargoOf(lost) : null;
        if (drop)
          items.push({
            time: e.time,
            kind: "storage",
            part: pageOf(e.pageId),
            text: `removes ${drop.label} from ${where}`,
            tone: "normal",
            hold: { op: "drop", cargo: drop, where },
          });
        if (gain)
          items.push({
            time: e.time,
            kind: "storage",
            part: pageOf(e.pageId),
            text: `stores ${gain.label} in ${where}`,
            tone: "normal",
            hold: { op: "gain", cargo: gain, where },
          });
        if (!gain && !drop) item(e, "storage", `${where}: ${String(e.op)}`);
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
      case "cookie":
        count(
          e.kind,
          item(e, "cookie", `cookie ${String(e.name)}: ${String(e.op)}`),
        );
        break;
      default:
        break;
    }
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
