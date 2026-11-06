import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { parseScryptPHC } from "./scrypt.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

// Hashes made with `new Scrypt().hash(password)` of lucia 3.2.0, the hasher
// of the Convex Auth v1 `Password` provider, as PHC strings. The v1 format is
// `<salt>:<hex key>`. The PHC salt is the UTF-8 bytes of the v1 salt (a hex
// string of 32 characters). N = 16384, r = 16, p = 1, key length 64.
const FIXTURES = {
  ascii: {
    password: "correct horse battery staple",
    phc: "$scrypt$ln=14,r=16,p=1$YzQwMzVkMTY1MzY3MDcwMDYxMDk0ZDQ0ZDRjODVkMzU$O9VL85i/QsMazu72eTz7j2uOe2SrPqP3RbluPdOAziT1Gw2xSo7YNg9CJ9Qsy+nSrSJ7Sfsv7ErBAIBt6+N+ug",
  },
  // 8 characters: the minimum of v1, and of the password component.
  minimumLength: {
    password: "hunter22",
    phc: "$scrypt$ln=14,r=16,p=1$NmRjMTFlNDcwNTlmYzNhODkxNjAxZWQ2ZTVlMjBjMGU$0RefB326CKLGK19NqPrRvZOFNReN/9tpz9sakbhkdpaa+IVNAdc9kiNuQaH+rdH1Q4Mux9WHN58hanmKTqrnEA",
  },
  // 7 characters: a v1 app can replace the rules of v1 and accept it.
  short: {
    password: "hunter2",
    phc: "$scrypt$ln=14,r=16,p=1$NTI1NTVhNTkwOTc3ZDg0YjlmZTkzZWJjZDBmMTA3MTQ$mdOXJRpP5D9GSP4xPGj8a6+EO8APWz9be/uYVar1MsAtQw4HePmeNXhlxR57jFt8qOGrj4VAXMPh6DqIIcVrTw",
  },
  // Surrounding whitespace: v1 accepts it.
  whitespace: {
    password: " hunter22 ",
    phc: "$scrypt$ln=14,r=16,p=1$YjYyMjcyNDdiOWRkNzQyMmUxZTdhMDBiZWIzZTU0NjQ$OZtGRpXSevAmDtU4du4Ruj8jzBi9buDWbo6oxAdJ41TAGluJ6jvvEG9jv1fawaEKbijYgVFkLDAufr5uNh/HMQ",
  },
  nonAscii: {
    password: "café crème brûlée 日本語",
    phc: "$scrypt$ln=14,r=16,p=1$YWFkOTk5YjMyNjgyYjUwMTU4ZThmMjY2OWNhOTlhM2M$iNiL2yxeOCLHAfL5xgaFumCP95LGGC0j7boFDnrDWG1IU2qwNuDlAVsJEHXd6amyijyZBFTRTq61R52bv+pLkA",
  },
  // U+FB01 ("ﬁ"): NFKC replaces it with "fi", NFC keeps it.
  ligature: {
    password: "ﬁnancial-pâssword",
    phc: "$scrypt$ln=14,r=16,p=1$Y2E4MjdhZjNmYjIzOTJjNjE5YzA4MjI1ZThkYjdlNTY$zl5UUxgv206saZSfocHmFrX/pEeW0wryGs/9Tjcp8sFfyoCw7IWk1yiVYQvLzE6OY08B15mxBlEk7pNCU3rajw",
  },
};

async function storedHash(
  t: ReturnType<typeof setup>,
  userId: string,
): Promise<string | null> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("passwords")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return row?.passwordHashPHC ?? null;
  });
}

/** Write a hash in the table, as a migration does. */
async function insertHash(
  t: ReturnType<typeof setup>,
  userId: string,
  passwordHashPHC: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("passwords", { userId, passwordHashPHC });
  });
}

describe("verifyPassword with a scrypt hash", () => {
  test("verifies the right password and keeps the scrypt hash", async () => {
    const t = setup();
    const phc = FIXTURES.ascii.phc;
    await insertHash(t, "alice", phc);

    const start = performance.now();
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: FIXTURES.ascii.password,
    });
    console.log(
      `verifyPassword (scrypt N=16384 r=16): ${Math.round(performance.now() - start)} ms`,
    );
    expect(result).toEqual({ success: true });

    // No upgrade: the row keeps the imported hash.
    expect(await storedHash(t, "alice")).toBe(phc);
  });

  test("a new password replaces the scrypt hash with an argon2id hash", async () => {
    const t = setup();
    await insertHash(t, "alice", FIXTURES.ascii.phc);
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "a brand new passphrase",
    });
    expect(await storedHash(t, "alice")).toMatch(/^\$argon2id\$/);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: FIXTURES.ascii.password,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CREDENTIALS" } });
  });

  test("rejects a wrong password and keeps the scrypt hash", async () => {
    const t = setup();
    const phc = FIXTURES.ascii.phc;
    await insertHash(t, "alice", phc);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: "wrong horse battery staple",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CREDENTIALS" } });
    expect(await storedHash(t, "alice")).toBe(phc);
  });

  test("verifies a non-ASCII password", async () => {
    const t = setup();
    await insertHash(t, "alice", FIXTURES.nonAscii.phc);
    // Decomposed form of the same text: NFKC gives the same bytes.
    const decomposed = FIXTURES.nonAscii.password.normalize("NFD");
    expect(decomposed).not.toBe(FIXTURES.nonAscii.password);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: decomposed,
      }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: FIXTURES.nonAscii.password,
      }),
    ).toEqual({ success: true });
  });

  test("normalizes to NFKC, as v1 does", async () => {
    const t = setup();
    await insertHash(t, "alice", FIXTURES.ligature.phc);
    // v1 accepts "fi" for "ﬁ", because NFKC replaces the ligature.
    const folded = FIXTURES.ligature.password.normalize("NFKC");
    expect(folded.startsWith("fi")).toBe(true);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: folded,
      }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: FIXTURES.ligature.password,
      }),
    ).toEqual({ success: true });
  });

  test("verifies a v1 password of 8 characters", async () => {
    const t = setup();
    await insertHash(t, "alice", FIXTURES.minimumLength.phc);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: FIXTURES.minimumLength.password,
      }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: "hunter23",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CREDENTIALS" } });
  });

  // The format rules of the component apply to all rows. Thus some v1
  // passwords do not verify, and these users must reset their password.
  test("applies the format rules to a scrypt row", async () => {
    const t = setup();
    await insertHash(t, "alice", FIXTURES.short.phc);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: FIXTURES.short.password,
      }),
    ).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 },
    });

    await insertHash(t, "bob", FIXTURES.whitespace.phc);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "bob",
        password: FIXTURES.whitespace.password,
      }),
    ).toEqual({
      success: false,
      userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  test("throws for a stored scrypt hash that does not parse", async () => {
    const t = setup();
    await insertHash(t, "alice", FIXTURES.ascii.phc.replace("ln=14", "ln=21"));
    await expect(
      t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: FIXTURES.ascii.password,
      }),
    ).rejects.toThrow("not a valid scrypt hash");
  });
});

describe("parseScryptPHC", () => {
  const valid = FIXTURES.ascii.phc;
  test("parses a valid string", () => {
    expect(parseScryptPHC(valid)).toMatchObject({ ln: 14, r: 16, p: 1 });
  });

  test.each([
    ["an empty string", ""],
    ["argon2id", "$argon2id$v=19$m=16384,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2g"],
    ["N too large", valid.replace("ln=14", "ln=21")],
    ["too much memory", valid.replace("ln=14", "ln=16")],
    ["r=0", valid.replace("r=16", "r=0")],
    ["padding", `${valid}==`],
    ["a bad character", valid.replace(/.$/, "!")],
    ["no hash", valid.slice(0, valid.lastIndexOf("$"))],
  ])("rejects %s", (_, phc) => {
    expect(parseScryptPHC(phc)).toBeNull();
  });
});
