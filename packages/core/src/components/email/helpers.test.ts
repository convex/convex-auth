import { describe, expect, test } from "vitest";
import { buildLink, challengeEmailText, formatDuration } from "./helpers.ts";

describe("buildLink", () => {
  test("appends the code with ? or & as the URL requires", () => {
    expect(buildLink("https://app.example/validate", "abc")).toBe(
      "https://app.example/validate?code=abc",
    );
    expect(buildLink("https://app.example/validate?flow=signUp", "abc")).toBe(
      "https://app.example/validate?flow=signUp&code=abc",
    );
  });

  test("URL-encodes the code", () => {
    expect(buildLink("https://app.example/v", "a+b/c=")).toBe(
      "https://app.example/v?code=a%2Bb%2Fc%3D",
    );
  });

  test("puts the code before the fragment of a hash-routed URL", () => {
    expect(buildLink("https://app.example/#/verify", "abc")).toBe(
      "https://app.example/?code=abc#/verify",
    );
    expect(buildLink("https://app.example/verify?flow=signUp#top", "abc")).toBe(
      "https://app.example/verify?flow=signUp&code=abc#top",
    );
  });

  test("replaces a code that the URL already has", () => {
    expect(buildLink("https://app.example/v?code=stale", "fresh")).toBe(
      "https://app.example/v?code=fresh",
    );
  });

  test("rejects a URL that is not absolute", () => {
    expect(() => buildLink("/verify", "abc")).toThrow("not a full URL");
  });

  test("rejects a URL that is missing its scheme", () => {
    expect(() => buildLink("localhost:5173/verify", "abc")).toThrow(
      'has no scheme ("localhost:" is read as the scheme)',
    );
  });

  test("accepts an app link", () => {
    expect(buildLink("myapp:///verify", "abc")).toBe(
      "myapp:///verify?code=abc",
    );
  });
});

describe("challengeEmailText", () => {
  test("puts the intro, the link and the expiry in the body", () => {
    const text = challengeEmailText(
      "Open this link:",
      "https://app.example/v?code=abc",
      10 * 60_000,
    );
    expect(text).toContain("Open this link:\n\nhttps://app.example/v?code=abc");
    expect(text).toContain("stops working after 10 minutes");
    expect(text).toContain("works only in the browser you started from");
  });
});

describe("formatDuration", () => {
  test("names minutes and whole hours", () => {
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(10 * 60_000)).toBe("10 minutes");
    expect(formatDuration(60 * 60_000)).toBe("1 hour");
    expect(formatDuration(24 * 60 * 60_000)).toBe("24 hours");
    expect(formatDuration(90 * 60_000)).toBe("90 minutes");
  });
});
