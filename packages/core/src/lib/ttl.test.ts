import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  resolveTtlConfig,
} from "./ttl.ts";

describe("resolveTtlConfig", () => {
  test("fills in every default when given nothing", () => {
    expect(resolveTtlConfig({})).toEqual({
      accessTokenTtlSeconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      refreshInactivityTimeoutSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
      sessionMaxLifetimeSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
    });
  });

  test("keeps the values the app sets", () => {
    expect(
      resolveTtlConfig({
        accessTokenTtlSeconds: 300,
        refreshInactivityTimeoutSeconds: 60 * 60,
        sessionMaxLifetimeSeconds: 2 * 60 * 60,
      }),
    ).toEqual({
      accessTokenTtlSeconds: 300,
      refreshInactivityTimeoutSeconds: 60 * 60,
      sessionMaxLifetimeSeconds: 2 * 60 * 60,
    });
  });

  test("defaults the inactivity timeout to the app's max lifetime", () => {
    expect(
      resolveTtlConfig({ sessionMaxLifetimeSeconds: 60 * 60 })
        .refreshInactivityTimeoutSeconds,
    ).toBe(60 * 60);
  });

  test("rejects an inactivity timeout longer than the default max lifetime", () => {
    expect(() =>
      resolveTtlConfig({
        refreshInactivityTimeoutSeconds:
          2 * DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
      }),
    ).toThrow(/at most the session max lifetime/i);
  });

  test.each([
    { accessTokenTtlSeconds: NaN },
    { refreshInactivityTimeoutSeconds: NaN },
    { sessionMaxLifetimeSeconds: NaN },
    { sessionMaxLifetimeSeconds: Infinity },
  ])("rejects a non-finite lifetime: %o", (args) => {
    expect(() => resolveTtlConfig(args)).toThrow(/finite/i);
  });
});
