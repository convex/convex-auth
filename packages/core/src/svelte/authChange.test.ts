import { describe, expect, it } from "vitest";
import { createAuthChangeDetector } from "./authChange.ts";

/** An unsigned access token of session `sub`. */
function jwt(sub: string, exp = 1) {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ sub, exp })}.sig`;
}

const loading = { isLoading: true, isAuthenticated: false, token: null };
const signedOut = { isLoading: false, isAuthenticated: false, token: null };
const signedIn = (sub: string, exp?: number) => ({
  isLoading: false,
  isAuthenticated: true,
  token: jwt(sub, exp),
});

describe("createAuthChangeDetector", () => {
  it("with SSR, reports an OAuth sign-in on a page rendered signed out", () => {
    const changed = createAuthChangeDetector(null);
    expect(changed(loading)).toBe(false);
    expect(changed(signedIn("session-b"))).toBe(true);
  });

  it("with SSR, ignores loading into the session the page was rendered with", () => {
    const changed = createAuthChangeDetector(jwt("session-a"));
    expect(changed(loading)).toBe(false);
    expect(changed(signedIn("session-a", 2))).toBe(false);
  });

  it("reports a switch to another session", () => {
    const changed = createAuthChangeDetector(jwt("session-a"));
    expect(changed(signedIn("session-b"))).toBe(true);
  });

  it("ignores token refreshes of the same session", () => {
    const changed = createAuthChangeDetector(undefined);
    expect(changed(signedIn("session-a", 1))).toBe(false);
    expect(changed(signedIn("session-a", 2))).toBe(false);
    expect(changed(signedIn("session-a", 3))).toBe(false);
  });

  it("without SSR, takes the first loaded state as the baseline", () => {
    const changed = createAuthChangeDetector(undefined);
    expect(changed(loading)).toBe(false);
    expect(changed(signedIn("session-a"))).toBe(false);
    expect(changed(signedOut)).toBe(true);
    expect(changed(signedOut)).toBe(false);
    expect(changed(signedIn("session-b"))).toBe(true);
  });
});
