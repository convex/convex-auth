import { describe, expect, test } from "vitest";
import { firstEntries, LogPoller, type LogPage } from "./logPoller.ts";

const entry = (id: string, seconds: number) => ({ id, timestamp: seconds });

describe("firstEntries", () => {
  test("keeps the entries that finished after the start, and the history", () => {
    const entries = [entry("a", 10), entry("b", 20), entry("c", 30)];
    expect(firstEntries(entries, 25_000, 0)).toEqual([entry("c", 30)]);
    expect(firstEntries(entries, 25_000, 1)).toEqual([
      entry("b", 20),
      entry("c", 30),
    ]);
  });
});

describe("LogPoller", () => {
  // The deployment answers the first request of an idle log stream when the
  // next function finishes. `npx convex logs` drops that entry; the poller
  // keeps it.
  test("keeps the run that ends the long poll of the first request", async () => {
    const startedAt = 1_000_000;
    const pages: LogPage[] = [
      { entries: [entry("first run", 1001)], newCursor: 1_001_000 },
      { entries: [entry("second run", 1002)], newCursor: 1_002_000 },
    ];
    const cursors: number[] = [];
    const poller = new LogPoller(async (cursor) => {
      cursors.push(cursor);
      return pages.shift()!;
    }, startedAt);
    expect(await poller.next()).toEqual([entry("first run", 1001)]);
    expect(await poller.next()).toEqual([entry("second run", 1002)]);
    expect(cursors).toEqual([0, 1_001_000]);
  });

  test("drops what ran before the start of a busy deployment", async () => {
    const poller = new LogPoller(
      async () => ({
        entries: [entry("old", 999), entry("new", 1001)],
        newCursor: 1_001_000,
      }),
      1_000_000,
    );
    expect(await poller.next()).toEqual([entry("new", 1001)]);
  });
});
