import { describe, expect, test } from "vitest";
import type { WriteEvent } from "./events.ts";
import { parseSyncPage, SyncReader } from "./sync.ts";
import { syncPages } from "./testFixtures.ts";

function readAll(pages: readonly string[]): WriteEvent[] {
  const reader = new SyncReader();
  return pages.flatMap((page) => reader.read(page).writes);
}

describe("parseSyncPage", () => {
  test("keeps the exact commit time in nanoseconds", () => {
    const raw = /"ts":(\d+)/.exec(syncPages[0])![1];
    const page = parseSyncPage(syncPages[0]);
    expect(page.status).toEqual({ type: "snapshotting" });
    expect(page.truncates).toEqual([
      { component: "auth", table: "createdUserIds" },
      { component: "auth", table: "ttlConfig" },
    ]);
    expect(page.writes[0].ts).toBe(raw);
    expect(page.writes[0].id).toBe(
      `auth/createdUserIds/${page.writes[0].documentId}@${raw}`,
    );
    expect(page.writes[0].time).toBeCloseTo(Number(raw) / 1e6, 0);
  });

  test("gives a delete with no value", () => {
    const deletes = syncPages
      .flatMap((page) => parseSyncPage(page).writes)
      .filter((write) => write.deleted);
    expect(deletes.length).toBeGreaterThan(0);
    for (const write of deletes) {
      expect(write.value).toBeNull();
      expect(write.documentId).not.toBe("");
    }
  });

  test("throws on a page that is not one", () => {
    expect(() => parseSyncPage('{"status":{"type":"what"}}')).toThrow();
    expect(() =>
      parseSyncPage('{"status":{"type":"snapshotting"},"values":[]}'),
    ).toThrow(/nextCursor/);
  });
});

describe("SyncReader", () => {
  test("marks the snapshot, and only the snapshot", () => {
    const writes = readAll(syncPages);
    expect(writes.filter((write) => write.snapshot)).toHaveLength(17);
    const live = writes.filter((write) => !write.snapshot);
    expect(live.length).toBeGreaterThan(0);
    // The snapshot comes first in the pages.
    expect(writes.findIndex((write) => !write.snapshot)).toBe(17);
  });

  test("holds the values back until it knows the snapshot time", () => {
    const reader = new SyncReader();
    expect(reader.read(syncPages[0]).writes).toEqual([]);
    expect(reader.cursor).not.toBeNull();
    expect(reader.upToDate).toBe(false);
  });

  test("a value of the snapshot on a stale page is part of the snapshot", () => {
    const page = (status: string, ts: string) =>
      `{"status":${status},"truncates":[],"values":[{"component":"","table":"users","ts":${ts},"deleted":false,"value":{"_id":"j573smrb10w028aq9jwgh1c5hs8jznta"}}],"syncId":"s","pagination":{"hasMore":true,"nextCursor":"c"}}`;
    const reader = new SyncReader();
    reader.read(page('{"type":"snapshotting"}', "1795729697315597545"));
    const { writes } = reader.read(
      page(
        '{"type":"stale","snapshotTs":1795729762355709941}',
        "1795729698311684612",
      ),
    );
    expect(writes.map((write) => write.snapshot)).toEqual([true, true]);
    const later = reader.read(
      page(
        '{"type":"upToDate","snapshotTs":1795729800000000000}',
        "1795729790000000000",
      ),
    );
    expect(later.writes.map((write) => write.snapshot)).toEqual([false]);
    expect(later.reset).toBe(false);
  });

  test("reports a new sync", () => {
    const reader = new SyncReader();
    for (const page of syncPages) {
      reader.read(page);
    }
    expect(
      reader.read(syncPages[0].replace(/"syncId":"[^"]+"/, '"syncId":"new"'))
        .reset,
    ).toBe(true);
  });

  test("redacts the secrets of every document", () => {
    const text = JSON.stringify(readAll(syncPages));
    expect(text).not.toMatch(/ffffffffffffffff/);
    expect(text).not.toMatch(/argon2/);
    expect(syncPages.join("\n")).toMatch(/ffffffffffffffff/);
  });
});
