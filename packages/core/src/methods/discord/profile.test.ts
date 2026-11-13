import { convexTest } from "convex-test";
import { makeFunctionReference, queryGeneric } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  normalizeDiscordProfile,
  vDiscordProfile,
  type DiscordProfile,
} from "./server.ts";

type DiscordUserInfo = NonNullable<
  Parameters<typeof normalizeDiscordProfile>[0]
>;

/** A user on the new username system, with no avatar of their own. */
const ID = "80351110224678912";

/**
 * Call `normalizeDiscordProfile` with a fake `/users/@me` response. The cast
 * lets tests feed loose and partial responses to exercise the defensive paths.
 */
function normalize(user: Record<string, unknown>) {
  return normalizeDiscordProfile({ user } as DiscordUserInfo);
}

/**
 * A query that takes the profile under `vDiscordProfile`, the way an app's
 * user callback declares it. convex-test validates the arguments, so a profile
 * the validator rejects fails the call.
 */
const testApp = {
  acceptProfile: queryGeneric({
    args: { profile: vDiscordProfile },
    handler: async () => null,
  }),
};

const acceptProfile = makeFunctionReference<
  "query",
  { profile: DiscordProfile },
  null
>("testApp:acceptProfile");

function acceptedProfile(profile: DiscordProfile) {
  // convex-test takes the root directory from the first path that contains
  // `_generated`, so the `_generated/api.ts` entry only has to exist.
  const t = convexTest(undefined, {
    "./_generated/api.ts": async () => ({}),
    "./testApp.ts": async () => testApp,
  });
  return t.query(acceptProfile, { profile });
}

describe("normalizeDiscordProfile", () => {
  test("uses the global name as the display name", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      global_name: "Nelly",
    });
    expect(profile.id).toBe(ID);
    expect(profile.username).toBe("nelly");
    expect(profile.name).toBe("Nelly");
  });

  test("falls back to the username when the global name is null", () => {
    const profile = normalize({ id: ID, username: "nelly", global_name: null });
    expect(profile.name).toBe("nelly");
  });

  test("falls back to the username when the global name is empty", () => {
    const profile = normalize({ id: ID, username: "nelly", global_name: "" });
    expect(profile.name).toBe("nelly");
  });

  test("marks a verified email as verified", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      email: "nelly@example.com",
      verified: true,
    });
    expect(profile.email).toBe("nelly@example.com");
    expect(profile.emailVerified).toBe(true);
  });

  test("marks an unverified email as unverified", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      email: "nelly@example.com",
      verified: false,
    });
    expect(profile.email).toBe("nelly@example.com");
    expect(profile.emailVerified).toBe(false);
  });

  test("leaves the email out when there is none", () => {
    for (const email of [undefined, null]) {
      const profile = normalize({
        id: ID,
        username: "nelly",
        email,
        verified: true,
      });
      expect(profile.email).toBeUndefined();
      expect(profile.emailVerified).toBe(false);
    }
  });

  test("builds a PNG URL for a custom avatar", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      avatar: "8342729096ea3675442027381ff50dfe",
    });
    expect(profile.avatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${ID}/8342729096ea3675442027381ff50dfe.png`,
    );
  });

  test("builds a GIF URL for an animated avatar", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      avatar: "a_8342729096ea3675442027381ff50dfe",
    });
    expect(profile.avatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${ID}/a_8342729096ea3675442027381ff50dfe.gif`,
    );
  });

  test("picks the default avatar of a migrated user from the id", () => {
    // (80351110224678912 >> 22) % 6 = 19157197529 % 6 = 5.
    for (const discriminator of ["0", undefined]) {
      const profile = normalize({
        id: ID,
        username: "nelly",
        discriminator,
        avatar: null,
      });
      expect(profile.avatarUrl).toBe(
        "https://cdn.discordapp.com/embed/avatars/5.png",
      );
    }
  });

  test("picks the default avatar of a legacy user from the discriminator", () => {
    const profile = normalize({
      id: ID,
      username: "Nelly",
      discriminator: "1337",
      avatar: null,
    });
    // 1337 % 5 = 2.
    expect(profile.avatarUrl).toBe(
      "https://cdn.discordapp.com/embed/avatars/2.png",
    );
    const other = normalize({
      id: ID,
      username: "Nelly",
      discriminator: "0004",
    });
    expect(other.avatarUrl).toBe(
      "https://cdn.discordapp.com/embed/avatars/4.png",
    );
  });

  test("uses the id rule when the discriminator is not digits", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      discriminator: "abcd",
    });
    expect(profile.avatarUrl).toBe(
      "https://cdn.discordapp.com/embed/avatars/5.png",
    );
  });

  test("falls back to the default avatar for a hash with unexpected characters", () => {
    for (const avatar of ["../../evil", "ABCDEF", "a_", "", "abc?x=1"]) {
      const profile = normalize({
        id: ID,
        username: "nelly",
        discriminator: "0",
        avatar,
      });
      expect(profile.avatarUrl).toBe(
        "https://cdn.discordapp.com/embed/avatars/5.png",
      );
    }
  });

  test("throws when the user response is missing", () => {
    expect(() => normalizeDiscordProfile({} as DiscordUserInfo)).toThrow(
      /missing the `user` entry/,
    );
    expect(() => normalizeDiscordProfile(undefined)).toThrow(
      /missing the `user` entry/,
    );
  });

  test("throws when the id is missing", () => {
    expect(() => normalize({ username: "nelly" })).toThrow(
      /missing a valid id/,
    );
  });

  test("throws when the id is a number", () => {
    expect(() => normalize({ id: 42, username: "nelly" })).toThrow(
      /missing a valid id/,
    );
  });

  test("throws when the id is not a string of digits", () => {
    for (const id of ["", "abc", "123abc", "-1", "1.5", " 1"]) {
      expect(() => normalize({ id, username: "nelly" })).toThrow(
        /missing a valid id/,
      );
    }
  });

  test("produces a profile that passes vDiscordProfile", async () => {
    const profiles = [
      normalize({ id: ID, username: "nelly" }),
      normalize({
        id: ID,
        username: "nelly",
        discriminator: "0",
        global_name: "Nelly",
        avatar: "a_8342729096ea3675442027381ff50dfe",
        email: "nelly@example.com",
        verified: true,
      }),
    ];
    for (const profile of profiles) {
      await expect(acceptedProfile(profile)).resolves.toBeNull();
    }
  });

  test("produces a profile that fails vDiscordProfile without a username", async () => {
    await expect(acceptedProfile(normalize({ id: ID }))).rejects.toThrow(
      /username/,
    );
  });
});
