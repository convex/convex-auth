/**
 * The places every browser has, whatever the app: the client library that
 * the structure map puts in the region, the Convex client and its WebSocket,
 * the page's own HTTP requests, localStorage and cookies. They are parts of
 * the region a recorded page runs in (`presentation.client`), so the layout
 * makes them districts of that region before anything is recorded. What the
 * recording adds (the page, its elements, the storage keys, the cookies) is
 * made by `convexPage.ts` with the ids below.
 */
import type { Graph, Part } from "../model/graph.ts";
import {
  fill,
  kindLook,
  partValues,
  type Presentation,
} from "../presentation.ts";

export const PLACES = {
  /** The client library of a region: where its modules stand. */
  library: (region: string) => `library:${region}`,
  /** The Convex client of the page, which owns the WebSocket. */
  convex: "browser:convex",
  /** The two ways out of the browser. */
  socket: "exit:socket",
  http: "exit:http",
  /** localStorage, sessionStorage and cookies. */
  store: (area: string) => `store:${area}`,
  storageKey: (key: string) => `storageKey:${key}`,
  cookie: (name: string) => `cookie:${name}`,
  /** An element of a page the person used. */
  element: (page: string, selector: string) => `element:${page}:${selector}`,
  /** The sign-in state of a page, as its client library reports it. */
  state: (page: string) => `state:${page}`,
} as const;

/** The exit a call of a transport leaves by. */
export const exitOf = (transport: string) =>
  transport === "http" ? PLACES.http : PLACES.socket;

const place = (
  id: string,
  kind: string,
  name: string,
  parent: string,
  observed: string,
): Part => ({
  id,
  kind,
  name,
  label: name,
  parent,
  source: null,
  facts: [],
  observed,
});

/**
 * The graph with the browser's places added under `presentation.client`, and
 * a client library for every region whose parts stand in one (a kind whose
 * `placeIn` names `library:…`).
 */
export function withBrowserPlaces(
  graph: Graph,
  presentation: Presentation,
): Graph {
  const ids = new Set(graph.parts.map((p) => p.id));
  const added: Part[] = [];
  const add = (p: Part) => {
    if (ids.has(p.id)) return;
    ids.add(p.id);
    added.push(p);
  };
  for (const p of graph.parts) {
    const template = kindLook(presentation, p.kind).placeIn;
    if (!template) continue;
    const target = fill(template, partValues(p));
    if (!target.startsWith("library:")) continue;
    const region = target.slice("library:".length);
    if (!ids.has(region)) continue;
    add(
      place(
        target,
        "library",
        presentation.parts?.[region]?.library ?? "client library",
        region,
        "The client code the structure map puts in this region.",
      ),
    );
  }
  const region = presentation.client;
  if (region && ids.has(region)) {
    add(
      place(
        PLACES.convex,
        "connection",
        "Convex client",
        region,
        "The page's Convex client: its WebSocket to the deployment.",
      ),
    );
    add(
      place(
        PLACES.socket,
        "exit",
        "WebSocket",
        PLACES.convex,
        "The WebSocket of the Convex client: queries, mutations and actions leave and return here.",
      ),
    );
    add(
      place(
        PLACES.http,
        "exit",
        "HTTP",
        region,
        "The page's HTTP requests leave and return here.",
      ),
    );
    add(
      place(
        PLACES.store("local"),
        "store",
        "localStorage",
        region,
        "The browser's localStorage for the page's origin.",
      ),
    );
    add(
      place(
        PLACES.store("cookies"),
        "store",
        "cookies",
        region,
        "The browser's cookies for the page's origin.",
      ),
    );
  }
  return added.length ? { ...graph, parts: [...graph.parts, ...added] } : graph;
}
