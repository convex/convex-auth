import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  resolveTtlConfig,
} from "./ttl.ts";

describe("resolveTtlConfig", () => {
  test("fills in every default when given nothing", () => {
    expect(resolveTtlConfig({})).toEqual({
      accessTokenTtlSeconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    });
  });

  test("keeps the values the app sets", () => {
    expect(
      resolveTtlConfig({
        accessTokenTtlSeconds: 300,
        refreshTokenTtlSeconds: 60 * 60,
      }),
    ).toEqual({ accessTokenTtlSeconds: 300, refreshTokenTtlSeconds: 60 * 60 });
  });

  test("rejects an access-token TTL above the default refresh-token TTL", () => {
    expect(() =>
      resolveTtlConfig({
        refreshTokenTtlSeconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      }),
    ).toThrow(/shorter than the refresh-token TTL/i);
  });

  test.each([
    { accessTokenTtlSeconds: NaN },
    { refreshTokenTtlSeconds: NaN },
    { refreshTokenTtlSeconds: Infinity },
  ])("rejects a non-finite TTL: %o", (args) => {
    expect(() => resolveTtlConfig(args)).toThrow(/finite/i);
  });
});
