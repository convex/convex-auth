import { describe, expect, test } from "vitest";
import { normalizeDiscordProfile } from "./server.ts";

type DiscordUserInfo = NonNullable<
  Parameters<typeof normalizeDiscordProfile>[0]
>;

/**
 * Call `normalizeDiscordProfile` with a fake `/users/@me` response. The cast
 * lets tests feed loose and partial responses to exercise the defensive paths.
 */
function normalize(user: Record<string, unknown>) {
  return normalizeDiscordProfile({ user } as DiscordUserInfo);
}

const ID = "80351110224678912";

describe("normalizeDiscordProfile", () => {
  test("maps a full response", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      global_name: "Nelly",
      discriminator: "0",
      avatar: "8342729096ea3675442027381ff50dfe",
      email: "nelly@example.com",
      verified: true,
    });
    expect(profile).toEqual({
      id: ID,
      username: "nelly",
      name: "Nelly",
      email: "nelly@example.com",
      emailVerified: true,
      avatarUrl: `https://cdn.discordapp.com/avatars/${ID}/8342729096ea3675442027381ff50dfe.png`,
    });
  });

  test("uses gif for an animated avatar", () => {
    const profile = normalize({ id: ID, username: "nelly", avatar: "a_1234" });
    expect(profile.avatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${ID}/a_1234.gif`,
    );
  });

  test("picks the default avatar from the id on the new username system", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      discriminator: "0",
      avatar: null,
    });
    const index = Number((BigInt(ID) >> 22n) % 6n);
    expect(profile.avatarUrl).toBe(
      `https://cdn.discordapp.com/embed/avatars/${index}.png`,
    );
  });

  test("picks the default avatar from a legacy discriminator", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      discriminator: "1337",
      avatar: null,
    });
    expect(profile.avatarUrl).toBe(
      "https://cdn.discordapp.com/embed/avatars/2.png",
    );
  });

  test("falls back the name to the username", () => {
    const profile = normalize({ id: ID, username: "nelly", global_name: null });
    expect(profile.name).toBe("nelly");
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

  test("leaves the email out when Discord has none", () => {
    const profile = normalize({
      id: ID,
      username: "nelly",
      email: null,
      verified: true,
    });
    expect(profile.email).toBeUndefined();
    expect(profile.emailVerified).toBe(false);
  });

  test("throws when the user response is missing", () => {
    expect(() => normalizeDiscordProfile({} as DiscordUserInfo)).toThrow(
      /missing the `user` entry/,
    );
  });

  test("throws when the user response has no id", () => {
    expect(() => normalize({ username: "nelly" })).toThrow(/missing an id/);
  });

  test("throws when the id is not a snowflake", () => {
    expect(() => normalize({ id: "undefined", username: "nelly" })).toThrow(
      /missing an id/,
    );
  });
});
