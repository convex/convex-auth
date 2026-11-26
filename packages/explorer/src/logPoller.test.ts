import { describe, expect, test } from "vitest";
import {
  deploymentStart,
  firstEntries,
  LogPoller,
  type TimedLogPage,
} from "./logPoller.ts";

const entry = (id: string, seconds: number) => ({ id, timestamp: seconds });

// A response with no `Date` header: the recorder's clock stands in.
const page = (entries: unknown[], newCursor: number): TimedLogPage => ({
  entries,
  newCursor,
  date: null,
  receivedAt: 0,
});

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
    const pages = [
      page([entry("first run", 1001)], 1_001_000),
      page([entry("second run", 1002)], 1_002_000),
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
      async () => page([entry("old", 999), entry("new", 1001)], 1_001_000),
      1_000_000,
    );
    expect(await poller.next()).toEqual([entry("new", 1001)]);
  });
});

describe("deploymentStart", () => {
  // The deployment's clock runs 60 s ahead of the recorder's. Its `Date`
  // header says 1_060_000 when the response arrives at 1_000_500.
  const start = deploymentStart(1_000_000, 1_060_000, 1_000_500);

  test("moves the start to the deployment's clock", () => {
    expect(start).toBe(1_059_500);
  });

  test("keeps a run that finished just after the start on the deployment's clock", async () => {
    const poller = new LogPoller(
      async () => ({
        // Old by the recorder's clock, new by the deployment's.
        entries: [entry("before", 1059.4), entry("after", 1060.1)],
        newCursor: 1_060_100,
        date: 1_060_000,
        receivedAt: 1_000_500,
      }),
      1_000_000,
    );
    expect(await poller.next()).toEqual([entry("after", 1060.1)]);
  });

  test("uses the recorder's clock without a header", () => {
    expect(deploymentStart(1_000_000, null, 1_000_500)).toBe(1_000_000);
  });
});
