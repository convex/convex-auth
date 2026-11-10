import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import { BACKUP_CODE_COUNT, hashBackupCode } from "./backupCodes.ts";
import { MAX_TOTPS_PER_USER, PENDING_ENROLLMENT_TTL_MS } from "./enrollment.ts";
import { base32Encode } from "./totp.ts";
import {
  ENROLLMENT,
  PERIOD_MS,
  addAuthenticator,
  advance,
  codeFor,
  controlClock,
  enroll,
  setup,
} from "../totpTestSetup.ts";

controlClock();

describe("createTotp", () => {
  test("returns the secret and the otpauth URI, and starts a pending enrollment", async () => {
    const t = setup();
    const { secret, otpauthUri } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toBe(
      `otpauth://totp/Acme:alice%40example.com?secret=${secret}&issuer=Acme&algorithm=SHA1&digits=6&period=30`,
    );
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
    const rows = await t.run((ctx) => ctx.db.query("totpSecrets").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "alice", status: "pending" });
    expect(base32Encode(new Uint8Array(rows[0].secret))).toBe(secret);
  });

  test("a second call replaces the pending secret", async () => {
    const t = setup();
    const first = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    const second = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(second.secret).not.toBe(first.secret);

    const rows = await t.run((ctx) => ctx.db.query("totpSecrets").collect());
    expect(rows).toHaveLength(1);
    expect(base32Encode(new Uint8Array(rows[0].secret))).toBe(second.secret);

    // Only the code of the last secret confirms the enrollment.
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(first.secret),
      }),
    ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(second.secret),
      }),
    ).toMatchObject({ success: true });
  });

  test("leaves an active secret in place until the new one is confirmed", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });

    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
    const active = await t.run((ctx) =>
      ctx.db
        .query("totpSecrets")
        .withIndex("by_userId_status", (q) =>
          q.eq("userId", "alice").eq("status", "active"),
        )
        .unique(),
    );
    expect(base32Encode(new Uint8Array(active!.secret))).toBe(secret);
  });

  test("touches only the given user's secrets and backup codes", async () => {
    const t = setup();
    const alice = await enroll(t, "alice");
    const alicePending = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });

    // Bob sees nothing of Alice's, and her pending code confirms nothing for
    // him.
    expect(await t.query(api.enrollment.getStatus, { userId: "bob" })).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "bob",
        code: await codeFor(alicePending.secret),
      }),
    ).toEqual({
      success: false,
      userError: { error: "NO_PENDING_ENROLLMENT" },
    });

    // Bob's enrollment replaces neither Alice's secrets nor her backup codes.
    await enroll(t, "bob");
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({ enabled: true, remainingBackupCodes: BACKUP_CODE_COUNT });
    const aliceActive = await t.run((ctx) =>
      ctx.db
        .query("totpSecrets")
        .withIndex("by_userId_status", (q) =>
          q.eq("userId", "alice").eq("status", "active"),
        )
        .unique(),
    );
    expect(base32Encode(new Uint8Array(aliceActive!.secret))).toBe(
      alice.secret,
    );
    const aliceCodes = await t.run((ctx) =>
      ctx.db
        .query("backupCodes")
        .withIndex("by_userId_codeHash", (q) => q.eq("userId", "alice"))
        .collect(),
    );
    expect(aliceCodes.map((row) => row.codeHash).sort()).toEqual(
      (
        await Promise.all(alice.backupCodes.map((code) => hashBackupCode(code)))
      ).sort(),
    );
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(alicePending.secret),
      }),
    ).toMatchObject({ success: true });
  });
});

describe("confirmTotp", () => {
  test("activates the secret and returns the backup codes", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    const result = await t.mutation(api.enrollment.confirmTotp, {
      userId: "alice",
      code: await codeFor(secret),
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.totpId).toEqual(expect.any(String));
    expect(result.backupCodes).toHaveLength(BACKUP_CODE_COUNT);
    for (const code of result.backupCodes ?? []) {
      expect(code).toMatch(/^[0-9a-z]{5}-[0-9a-z]{5}$/);
    }

    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
  });

  test("accepts a code with a space in the middle", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    const code = await codeFor(secret);
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: `${code.slice(0, 3)} ${code.slice(3)}`,
      }),
    ).toMatchObject({ success: true });
  });

  test("tolerates one step of clock drift in each direction", async () => {
    for (const offset of [-PERIOD_MS, PERIOD_MS]) {
      const t = setup();
      const { secret } = await t.mutation(api.enrollment.createTotp, {
        userId: "alice",
        ...ENROLLMENT,
      });
      expect(
        await t.mutation(api.enrollment.confirmTotp, {
          userId: "alice",
          code: await codeFor(secret, Date.now() + offset),
        }),
        `offset ${offset}`,
      ).toMatchObject({ success: true });
    }
  });

  test("rejects a code from outside the window", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    for (const offset of [-2 * PERIOD_MS, 2 * PERIOD_MS]) {
      expect(
        await t.mutation(api.enrollment.confirmTotp, {
          userId: "alice",
          code: await codeFor(secret, Date.now() + offset),
        }),
        `offset ${offset}`,
      ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    }
  });

  test("rejects a malformed code", async () => {
    const t = setup();
    await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    for (const code of ["", "12345", "1234567", "abcdef", "12345a"]) {
      expect(
        await t.mutation(api.enrollment.confirmTotp, { userId: "alice", code }),
        JSON.stringify(code),
      ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    }
  });

  test("stores only the hashes of the backup codes", async () => {
    const t = setup();
    const { backupCodes } = await enroll(t);
    const rows = await t.run((ctx) => ctx.db.query("backupCodes").collect());
    const stored = rows.map((row) => row.codeHash).sort();
    const hashes = (
      await Promise.all(backupCodes.map((code) => hashBackupCode(code)))
    ).sort();
    expect(stored).toEqual(hashes);
    for (const row of rows) {
      expect(backupCodes).not.toContain(row.codeHash);
    }
  });

  test("rejects a wrong code and keeps the enrollment pending", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    // A code from ten minutes ago is outside the window.
    const stale = await codeFor(secret, Date.now() - 10 * 60 * 1000);
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: stale,
      }),
    ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
    // The right code still confirms it.
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toMatchObject({ success: true });
  });

  test("refuses a user with no pending secret", async () => {
    const t = setup();
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: "123456",
      }),
    ).toEqual({
      success: false,
      userError: { error: "NO_PENDING_ENROLLMENT" },
    });

    // A confirmed enrollment is not pending any more.
    const { secret } = await enroll(t);
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({
      success: false,
      userError: { error: "NO_PENDING_ENROLLMENT" },
    });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toMatchObject({ enabled: true });
  });

  test("refuses a pending secret that is an hour old", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    advance(PENDING_ENROLLMENT_TTL_MS);
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({
      success: false,
      userError: { error: "NO_PENDING_ENROLLMENT" },
    });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toMatchObject({ enabled: false });

    // A new enrollment can be confirmed.
    const next = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(next.secret),
      }),
    ).toMatchObject({ success: true });
  });

  test("accepts a pending secret until it is an hour old", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    advance(PENDING_ENROLLMENT_TTL_MS - PERIOD_MS);
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toMatchObject({ success: true });
  });

  test("adds a second authenticator, and keeps the backup codes", async () => {
    const t = setup();
    const first = await enroll(t);
    const second = await addAuthenticator(t);
    expect(second.backupCodes).toBeUndefined();
    expect(second.totpId).not.toBe(first.totpId);

    const rows = await t.run((ctx) => ctx.db.query("totpSecrets").collect());
    expect(rows.map((row) => row.status)).toEqual(["active", "active"]);
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({ enabled: true, remainingBackupCodes: BACKUP_CODE_COUNT });

    // The backup codes are still those of the first enrollment.
    const stored = await t.run((ctx) => ctx.db.query("backupCodes").collect());
    expect(stored.map((row) => row.codeHash).sort()).toEqual(
      (
        await Promise.all(first.backupCodes.map((code) => hashBackupCode(code)))
      ).sort(),
    );
  });

  test("refuses an authenticator past the limit, and keeps it pending", async () => {
    const t = setup();
    await enroll(t);
    for (let i = 1; i < MAX_TOTPS_PER_USER; i++) {
      await addAuthenticator(t);
    }
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(
      await t.mutation(api.enrollment.confirmTotp, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: false, userError: { error: "TOO_MANY_TOTPS" } });
    expect(
      await t.query(api.enrollment.listTotps, { userId: "alice" }),
    ).toHaveLength(MAX_TOTPS_PER_USER);
    const pending = await t.run((ctx) =>
      ctx.db
        .query("totpSecrets")
        .withIndex("by_userId_status", (q) =>
          q.eq("userId", "alice").eq("status", "pending"),
        )
        .unique(),
    );
    expect(base32Encode(new Uint8Array(pending!.secret))).toBe(secret);
  });

  test("records the step of the confirmation code", async () => {
    const t = setup();
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    await t.mutation(api.enrollment.confirmTotp, {
      userId: "alice",
      code: await codeFor(secret),
    });
    const row = await t.run((ctx) => ctx.db.query("totpSecrets").unique());
    // The counter of the current step, thus the confirmation code cannot be
    // replayed at sign-in.
    expect(row?.lastUsedCounter).toBe(Math.floor(Date.now() / 1000 / 30));
  });
});

describe("listTotps", () => {
  test("lists the active secrets of the user, oldest first", async () => {
    const t = setup();
    expect(
      await t.query(api.enrollment.listTotps, { userId: "alice" }),
    ).toEqual([]);
    const first = await enroll(t);
    const second = await addAuthenticator(t);
    await enroll(t, "bob");
    // A pending enrollment is not listed.
    await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });

    const listed = await t.query(api.enrollment.listTotps, { userId: "alice" });
    expect(listed.map((row) => row.totpId)).toEqual([
      first.totpId,
      second.totpId,
    ]);
    expect(listed[0].createdAt).toBeLessThan(listed[1].createdAt);
    // Nothing of the secret is listed.
    expect(Object.keys(listed[0]).sort()).toEqual(["createdAt", "totpId"]);
  });
});

describe("getStatus", () => {
  test("reports an unknown user as not enrolled", async () => {
    const t = setup();
    expect(
      await t.query(api.enrollment.getStatus, { userId: "nobody" }),
    ).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
  });
});
