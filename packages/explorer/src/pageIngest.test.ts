import { describe, expect, test } from "vitest";
import { BrowserRedactor, type Cookie } from "./browser.ts";
import type { TimelineEvent } from "./events.ts";
import { nodeDigest } from "./nodeDigest.ts";
import { PageIngest } from "./pageIngest.ts";
import { GENERIC_BROWSER, GENERIC_PROJECT } from "./project.ts";
import { convexAuthProject } from "./projects/convexAuth.ts";
import { Secrets } from "./secrets.ts";
import {
  browserFixture,
  FIXTURE_DEPLOYMENT,
  replayBrowserFixture,
} from "./testFixtures.ts";

function ingest(project = GENERIC_PROJECT, now?: () => number) {
  const events: TimelineEvent[] = [];
  const secrets = new Secrets(project.browser ?? GENERIC_BROWSER, nodeDigest);
  const page = new PageIngest({
    redactor: new BrowserRedactor(project, secrets),
    secrets,
    deploymentUrl: FIXTURE_DEPLOYMENT,
    origin: "http://localhost:5173",
    emit: (batch) => events.push(...batch, ...secrets.drain()),
    now,
  });
  return { page, events, secrets };
}

/** An event without the ids that depend on what else was recorded. */
function shape(event: TimelineEvent): unknown {
  const {
    id: _id,
    requestEventId: _req,
    responseEventId: _res,
    firstSeenIn: _first,
    ...rest
  } = event as Record<string, unknown>;
  return rest;
}

describe("PageIngest", () => {
  test("reads the page's observations into the same events as the DevTools recorder", () => {
    const { events: expected } = replayBrowserFixture(convexAuthProject);
    const { page, events, secrets } = ingest(convexAuthProject);
    const opened = new Set<string>();
    const items: Record<string, unknown>[] = [];
    for (const input of browserFixture.inputs as Record<string, unknown>[]) {
      if (input.type === "frame") {
        const socket = Number(String(input.socketId).replace("ws", ""));
        if (!opened.has(String(input.socketId))) {
          opened.add(String(input.socketId));
          items.push({
            type: "socket",
            socket,
            direction: "open",
            url: "ws://127.0.0.1:3210/api/sync",
            time: input.time,
          });
        }
        items.push({ ...input, type: "socket", socket });
      } else if (input.type === "storage") {
        items.push({ ...input, area: "local" });
      } else if (input.resourceType === "fetch") {
        items.push(input);
      }
    }
    // Sent in three numbered parts, out of order.
    const third = Math.ceil(items.length / 3);
    page.receive({ doc: "d", seq: 2, items: items.slice(2 * third) });
    expect(events).toEqual([]);
    page.receive({ doc: "d", seq: 0, items: items.slice(0, third) });
    page.receive({ doc: "d", seq: 1, items: items.slice(third, 2 * third) });
    const end = browserFixture.inputs.at(-1)!.time;
    for (const document of browserFixture.documents) {
      secrets.observeDocument(
        document.component,
        document.table,
        document.documentId,
        document.value,
        end,
      );
    }
    events.push(...secrets.drain());

    const kept = (e: TimelineEvent) =>
      !(e.kind === "socket" && e.direction === "open") &&
      !(e.kind === "http" && e.resourceType !== "fetch");
    const socketId = (e: unknown) =>
      JSON.parse(JSON.stringify(e).replace(/"p1\.ws(\d+)"/g, '"ws$1"'));
    expect(events.filter(kept).map(shape).map(socketId)).toEqual(
      expected.filter(kept).map(shape),
    );
    expect(
      events.filter((e) => e.kind === "socket" && e.direction === "open"),
    ).toHaveLength(opened.size);
  });

  test("drops what does not fit, and keeps reading", () => {
    const { page, events } = ingest();
    expect(page.receive(null)).toBe(false);
    expect(page.receive({ doc: "d", seq: -1, items: [] })).toBe(false);
    expect(page.receive({ doc: "d", seq: 0, items: "no" })).toBe(false);
    expect(
      page.receive({
        doc: "d",
        seq: 0,
        items: [
          null,
          { type: "document", url: "javascript:alert(1)" },
          { type: "console", level: "debug", text: "x" },
          { type: "storage", area: "cookies", op: "set", key: "k" },
          { type: "input", action: "hover", target: {} },
          {
            type: "http",
            url: "http://x",
            method: "GET",
            resourceType: "image",
          },
          { type: "socket", socket: 9, direction: "sent", payload: "{}" },
          { type: "console", level: "error", text: "boom", time: 5 },
        ],
      }),
    ).toBe(true);
    expect(events).toEqual([
      {
        kind: "console",
        id: "p1#1",
        time: 5,
        pageId: "p1",
        level: "error",
        text: "boom",
      },
    ]);
  });

  test("waits for a gap, then goes on without it", () => {
    let now = 0;
    const { page, events } = ingest(GENERIC_PROJECT, () => now);
    const item = (text: string) => ({ type: "console", level: "error", text });
    page.receive({ doc: "d", seq: 1, items: [item("second")] });
    page.tick();
    expect(events).toEqual([]);
    now = 2500;
    page.tick();
    expect(events.map((e) => (e as { text: string }).text)).toEqual(["second"]);
    // The lost send, late: dropped, as its place has passed.
    page.receive({ doc: "d", seq: 0, items: [item("first")] });
    expect(events).toHaveLength(1);
  });

  test("opens the page once, and navigates it on each document", () => {
    const { page, events } = ingest();
    page.receive({
      doc: "a",
      seq: 0,
      items: [{ type: "document", url: "http://localhost:5173/", time: 1 }],
    });
    page.receive({
      doc: "b",
      seq: 0,
      items: [
        { type: "document", url: "http://localhost:5173/x?code=abc", time: 2 },
        { type: "load", url: "http://localhost:5173/x?code=abc", time: 3 },
      ],
    });
    expect(
      events.map((e) => [
        e.kind,
        (e as { event: string }).event,
        (e as { url: string }).url,
      ]),
    ).toEqual([
      ["page", "open", "http://localhost:5173/"],
      ["page", "navigated", "http://localhost:5173/"],
      ["page", "navigated", "http://localhost:5173/x?code=%5Bredacted%5D"],
      ["page", "load", "http://localhost:5173/x?code=%5Bredacted%5D"],
    ]);
    expect(JSON.stringify(events)).not.toContain("abc");
  });

  test("a cookie that the page and the server both see is one cookie", () => {
    const { page, events } = ingest();
    const cookie: Cookie = {
      name: "session",
      value: "a-cookie-value-that-is-long",
      domain: "localhost",
      path: "/",
      expires: 2_000_000_000,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    page.serverCookies([cookie], [], 1);
    page.receive({
      doc: "d",
      seq: 0,
      items: [
        {
          type: "cookies",
          time: 2,
          changed: [{ ...cookie, expires: 2_000_000_001 }],
          deleted: [],
        },
      ],
    });
    page.serverCookies([{ ...cookie, name: "hidden", httpOnly: true }], [], 3);
    page.serverCookies([], [cookie], 4);
    expect(
      events
        .filter((e) => e.kind === "cookie")
        .map((e) => [
          (e as { op: string }).op,
          (e as { name: string }).name,
          (e as { httpOnly: boolean }).httpOnly,
        ]),
    ).toEqual([
      ["set", "session", false],
      ["set", "hidden", true],
      ["remove", "session", false],
    ]);
    expect(JSON.stringify(events)).not.toContain(cookie.value);
  });
});
