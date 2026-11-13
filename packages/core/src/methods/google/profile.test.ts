import { describe, expect, test } from "vitest";
import { normalizeGoogleProfile } from "./server.ts";

describe("normalizeGoogleProfile", () => {
  test("maps validated id_token claims to the profile", () => {
    const profile = normalizeGoogleProfile({
      sub: "123",
      email: "user@example.com",
      email_verified: true,
      name: "A User",
      picture: "https://example.com/avatar.png",
    });
    expect(profile).toEqual({
      id: "123",
      email: "user@example.com",
      emailVerified: true,
      hostedDomain: undefined,
      name: "A User",
      picture: "https://example.com/avatar.png",
    });
  });

  test("carries the Workspace domain of a Workspace account", () => {
    const profile = normalizeGoogleProfile({
      sub: "123",
      email: "teacher@school.example",
      email_verified: true,
      hd: "school.example",
    });
    expect(profile.hostedDomain).toBe("school.example");
  });

  test("leaves the domain out for a personal account and for a malformed claim", () => {
    expect(
      normalizeGoogleProfile({ sub: "123", email: "user@gmail.com" })
        .hostedDomain,
    ).toBeUndefined();
    expect(
      normalizeGoogleProfile({ sub: "123", hd: ["school.example"] })
        .hostedDomain,
    ).toBeUndefined();
  });

  test("treats an absent email_verified claim as unverified", () => {
    const profile = normalizeGoogleProfile({
      sub: "123",
      email: "user@example.com",
    });
    expect(profile.emailVerified).toBe(false);
  });

  test("throws when there is no id_token to map", () => {
    expect(() => normalizeGoogleProfile(undefined)).toThrow(/no id_token/);
  });
});
