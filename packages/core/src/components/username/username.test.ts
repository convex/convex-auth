import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { MAX_USERNAME_LENGTH } from "./validation.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

describe("setUsername", () => {
  test("sets a username for a user with no username", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "Alice",
    });
    expect(result).toEqual({ success: true, previousUsername: null });
    expect(await t.query(api.public.getUsername, { userId: "user1" })).toBe(
      "Alice",
    );
  });

  test("renames a user and returns the previous username", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "Alice",
    });
    const result = await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "Bob",
    });
    expect(result).toEqual({ success: true, previousUsername: "Alice" });

    // Only one row exists for the user, and the old username is free.
    const count = await t.run(
      async (ctx) => (await ctx.db.query("usernames").collect()).length,
    );
    expect(count).toBe(1);
    expect(
      await t.query(api.public.getUserIdByUsername, { username: "alice" }),
    ).toBe(null);
    expect(
      await t.query(api.public.getUserIdByUsername, { username: "bob" }),
    ).toBe("user1");
  });

  test("keeps the new spelling when the same user sets the same username", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "alice",
    });
    const result = await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "ALICE",
    });
    expect(result).toEqual({ success: true, previousUsername: "alice" });
    expect(await t.query(api.public.getUsername, { userId: "user1" })).toBe(
      "ALICE",
    );
  });

  test("rejects a username that a different user has", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "alice",
    });
    const result = await t.mutation(api.public.setUsername, {
      userId: "user2",
      username: "alice",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
    expect(await t.query(api.public.getUsername, { userId: "user2" })).toBe(
      null,
    );
  });

  test("rejects a username that a different user has, in a different case", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "Alice",
    });
    const result = await t.mutation(api.public.setUsername, {
      userId: "user2",
      username: "ALICE",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("rejects an empty username", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_TOO_SHORT", minimumLength: 1 },
    });
  });

  test("accepts a one-character username and a username of the maximum length", async () => {
    const t = setup();
    expect(
      await t.mutation(api.public.setUsername, {
        userId: "user1",
        username: "a",
      }),
    ).toEqual({ success: true, previousUsername: null });
    // The length counts code points, thus an astral character counts as one.
    const long = "😀".repeat(MAX_USERNAME_LENGTH);
    expect(
      await t.mutation(api.public.setUsername, {
        userId: "user2",
        username: long,
      }),
    ).toEqual({ success: true, previousUsername: null });
    expect(
      await t.query(api.public.getUserIdByUsername, { username: long }),
    ).toBe("user2");
  });

  test("rejects a username that is too long", async () => {
    const t = setup();
    for (const username of [
      "b".repeat(MAX_USERNAME_LENGTH + 1),
      "b".repeat(1_000_000),
    ]) {
      expect(
        await t.mutation(api.public.setUsername, { userId: "user1", username }),
      ).toEqual({
        success: false,
        userError: {
          error: "USERNAME_TOO_LONG",
          maximumLength: MAX_USERNAME_LENGTH,
        },
      });
      expect(
        await t.query(api.public.getUserIdByUsername, { username }),
      ).toBeNull();
    }
  });

  test("rejects a username with surrounding whitespace", async () => {
    const t = setup();
    for (const username of [" alice", "alice ", "\talice", "alice\u3000"]) {
      expect(
        await t.mutation(api.public.setUsername, { userId: "user1", username }),
      ).toEqual({
        success: false,
        userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
      });
    }
  });

  test("rejects a username that is only whitespace", async () => {
    const t = setup();
    expect(
      await t.mutation(api.public.setUsername, {
        userId: "user1",
        username: " ",
      }),
    ).toEqual({
      success: false,
      userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  test("accepts a space inside the username", async () => {
    const t = setup();
    expect(
      await t.mutation(api.public.setUsername, {
        userId: "user1",
        username: "alice smith",
      }),
    ).toEqual({ success: true, previousUsername: null });
  });

  test("rejects malformed characters", async () => {
    const t = setup();
    const malformed = {
      "a NUL character": "ali\u0000ce",
      "a line feed": "ali\nce",
      "a delete character": "ali\u007fce",
      "a C1 control": "ali\u009dce",
      "a right-to-left override": "ali\u202ece",
      "a zero-width space": "ali\u200bce",
      "a byte order mark": "ali\ufeffce",
      "a no-break space": "ali\u00a0ce",
      "an ideographic space": "ali\u3000ce",
      "a noncharacter": "ali\ufffece",
      "a plane-end noncharacter": "ali\u{1fffe}ce",
      "an unpaired surrogate": "ali\ud800ce",
      "a leading combining mark": "\u0301alice",
    };
    for (const [description, username] of Object.entries(malformed)) {
      expect(
        await t.mutation(api.public.setUsername, { userId: "user1", username }),
        description,
      ).toEqual({
        success: false,
        userError: { error: "USERNAME_HAS_INVALID_CHARACTERS" },
      });
    }
  });

  test("accepts usernames of all scripts", async () => {
    const t = setup();
    const accepted = [
      "أحمد", // Arabic
      "中文名", // Chinese
      "Алиса", // Cyrillic
      "ひらがな", // Japanese
      "Renée-Élise",
      "user_name.42",
      // A zero-width joiner is necessary for some scripts and for emoji
      // sequences, thus it stays permitted.
      "family\u{1f468}\u200d\u{1f469}\u200d\u{1f466}",
    ];
    let userId = 0;
    for (const username of accepted) {
      expect(
        await t.mutation(api.public.setUsername, {
          userId: `user${userId++}`,
          username,
        }),
        username,
      ).toEqual({ success: true, previousUsername: null });
    }
  });

  test("counts an astral character as one character", async () => {
    const t = setup();
    // A single emoji is two UTF-16 units but one code point.
    const result = await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "😀",
    });
    expect(result).toEqual({ success: true, previousUsername: null });
  });
});

describe("Unicode normalization", () => {
  // "café" spelled two ways: composed é (U+00E9) and decomposed
  // e + combining acute (U+0301).
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";

  test("finds a user across differing normalization forms", async () => {
    const t = setup();
    expect(composed).not.toBe(decomposed);

    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: composed,
    });
    expect(
      await t.query(api.public.getUserIdByUsername, { username: decomposed }),
    ).toBe("user1");
  });

  test("rejects the same username in a different normalization form", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: composed,
    });
    const result = await t.mutation(api.public.setUsername, {
      userId: "user2",
      username: decomposed,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("stores the username as the user supplied it", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "AlIcE",
    });
    const row = await t.run(
      async (ctx) => await ctx.db.query("usernames").unique(),
    );
    expect(row?.username).toBe("AlIcE");
    expect(row?.usernameNormalized).toBe("alice");
  });
});

describe("getUserIdByUsername", () => {
  test("ignores the case of the argument", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "Alice",
    });
    expect(
      await t.query(api.public.getUserIdByUsername, { username: "ALICE" }),
    ).toBe("user1");
    expect(
      await t.query(api.public.getUserIdByUsername, { username: "alice" }),
    ).toBe("user1");
  });

  test("returns null for an unknown username", async () => {
    const t = setup();
    expect(
      await t.query(api.public.getUserIdByUsername, { username: "nobody" }),
    ).toBe(null);
  });
});

describe("getUsername", () => {
  test("returns null for a user with no username", async () => {
    const t = setup();
    expect(await t.query(api.public.getUsername, { userId: "nobody" })).toBe(
      null,
    );
  });
});

describe("deleteUsername", () => {
  test("deletes the username of a user", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "alice",
    });
    expect(
      await t.mutation(api.public.deleteUsername, { userId: "user1" }),
    ).toEqual({ deleted: true });
    expect(await t.query(api.public.getUsername, { userId: "user1" })).toBe(
      null,
    );
    expect(
      await t.query(api.public.getUserIdByUsername, { username: "alice" }),
    ).toBe(null);
  });

  test("makes the username available to a different user", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "alice",
    });
    await t.mutation(api.public.deleteUsername, { userId: "user1" });
    expect(
      await t.mutation(api.public.setUsername, {
        userId: "user2",
        username: "alice",
      }),
    ).toEqual({ success: true, previousUsername: null });
  });

  test("reports deleted: false when the user has no username", async () => {
    const t = setup();
    expect(
      await t.mutation(api.public.deleteUsername, { userId: "nobody" }),
    ).toEqual({ deleted: false });
  });

  test("deletes only the username of the given user", async () => {
    const t = setup();
    await t.mutation(api.public.setUsername, {
      userId: "user1",
      username: "alice",
    });
    await t.mutation(api.public.setUsername, {
      userId: "user2",
      username: "bob",
    });
    await t.mutation(api.public.deleteUsername, { userId: "user1" });
    expect(await t.query(api.public.getUsername, { userId: "user2" })).toBe(
      "bob",
    );
  });
});
