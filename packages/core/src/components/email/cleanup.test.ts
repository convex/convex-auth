import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.ts";
import { WORKER_NAME } from "./cleanup.ts";
import { seedChallenge, setup } from "../emailTestSetup.ts";

const START = new Date("2026-01-01T00:00:00Z").getTime();
// When the scans run. The clock of a transaction never goes back before the
// last commit, and each commit moves that clock forward, thus a scan right after
// seeding at a frozen `START` would read `Date.now()` as `START + 1`. The scans
// run at a later `NOW` instead, so that their `Date.now()` is exact.
const NOW = START + 60_000;

/** Seed a challenge that expires at `expiresAt`, and return its ID. */
async function insertChallenge(
  t: ReturnType<typeof setup>,
  emailCode: string,
  expiresAt: number,
) {
  await seedChallenge(t, {
    email: `${emailCode}@example.com`,
    purpose: { kind: "addEmail", userId: "user1" },
    emailCode,
    browserSecret: "secret",
    expiresAt,
  });
  const row = await t.run(async (ctx) =>
    (await ctx.db.query("challenges").collect()).find(
      (row) => row.email === `${emailCode}@example.com`,
    ),
  );
  return row!._id;
}

/** Run the scan at `NOW`. */
async function getExpiredChallengesAtNow(
  t: ReturnType<typeof setup>,
  args: { cursor?: number } = {},
) {
  vi.setSystemTime(NOW);
  return await t.query(internal.cleanup.getExpiredChallenges, {
    name: WORKER_NAME,
    ...args,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getExpiredChallenges", () => {
  test("goes idle with no timeout when the table is empty", async () => {
    const t = setup();
    const result = await getExpiredChallengesAtNow(t);
    expect(result).toEqual({ kind: "idle" });
  });

  test("returns only the challenges that are expired, in expiry order", async () => {
    const t = setup();
    // The rows are created in another order than they expire: a custom
    // challenge with a long TTL can be older than a short one.
    const laterId = await insertChallenge(t, "later", NOW - 5);
    await insertChallenge(t, "fresh", NOW + 1);
    const earlierId = await insertChallenge(t, "earlier", NOW - 10);

    const result = await getExpiredChallengesAtNow(t);
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: earlierId }, { id: laterId }] },
      cursor: NOW - 5,
    });
  });

  test("goes idle until the next challenge expires", async () => {
    const t = setup();
    await insertChallenge(t, "soon", NOW + 1000);
    await insertChallenge(t, "late", NOW + 60_000);

    const result = await getExpiredChallengesAtNow(t);
    expect(result).toEqual({ kind: "idle", timeoutMs: 1000 });
  });

  test("the cursor skips the rows that the loop already erased", async () => {
    const t = setup();
    // A row that stays below the cursor is a stale read for the loop: only a
    // tombstone can be below the cursor in production.
    await insertChallenge(t, "gone", NOW - 10);
    const laterId = await insertChallenge(t, "later", NOW - 5);

    const result = await getExpiredChallengesAtNow(t, { cursor: NOW - 5 });
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: laterId }] },
      cursor: NOW - 5,
    });
  });

  test("a wake-up at exactly the deadline finds work", async () => {
    const t = setup();
    // At exactly `expiresAt` the challenge is expired. A wake-up at the
    // deadline must find the row, or the loop would go idle with
    // `timeoutMs: 0` forever.
    const id = await insertChallenge(t, "now", NOW);

    const result = await getExpiredChallengesAtNow(t);
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id }] },
      cursor: NOW,
    });
  });
});

describe("deleteExpiredChallenges", () => {
  test("erases the rows of the batch and keeps the others", async () => {
    const t = setup();
    const expiredId = await insertChallenge(t, "expired", START - 1);
    const freshId = await insertChallenge(t, "fresh", START + 1);
    await seedChallenge(t, {
      email: "custom@example.com",
      purpose: { kind: "changeEmail", userId: "user2" },
      emailCode: "custom",
      browserSecret: "secret",
      expiresAt: START + 1,
    });

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      events: [{ id: expiredId }],
    });

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row._id)).toContain(freshId);
    expect(remaining.map((row) => row._id)).not.toContain(expiredId);
    expect(remaining).toHaveLength(2);
  });
});
