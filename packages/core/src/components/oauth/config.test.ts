import { afterEach, describe, expect, test, vi } from "vitest";
import { providerConfig } from "./config.ts";

function withEnv(env: Record<string, string>) {
  vi.stubEnv("TOKEN_ENDPOINT", "https://provider.example/token");
  vi.stubEnv("ISSUERS", "");
  vi.stubEnv("USERINFO_ENDPOINTS", "");
  vi.stubEnv("ACCOUNT_ID_FIELD", "");
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  return providerConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("providerConfig", () => {
  test("reads the issuers, separated by commas", () => {
    expect(
      withEnv({ ISSUERS: "https://a.example, a.example" }).issuers,
    ).toEqual(["https://a.example", "a.example"]);
  });

  test("reads the userinfo endpoints, and an account id field of one of them", () => {
    const config = withEnv({
      USERINFO_ENDPOINTS: JSON.stringify({ user: "https://a.example/user" }),
      ACCOUNT_ID_FIELD: "user.id",
    });
    expect(config.userInfoEndpoints).toEqual({
      user: "https://a.example/user",
    });
    expect(config.accountId({ userInfoResponses: { user: { id: 7 } } })).toBe(
      "7",
    );
  });

  test("uses the `sub` claim by default", () => {
    expect(withEnv({}).accountId({ claims: { sub: "s-1" } })).toBe("s-1");
  });

  test.each([
    [{ TOKEN_ENDPOINT: "http://provider.example/token" }, "TOKEN_ENDPOINT"],
    [{ TOKEN_ENDPOINT: "" }, "TOKEN_ENDPOINT"],
    [{ ISSUERS: "https://a.example,," }, "ISSUERS"],
    [{ USERINFO_ENDPOINTS: "[]" }, "USERINFO_ENDPOINTS"],
    [
      { USERINFO_ENDPOINTS: JSON.stringify({ user: "http://a.example" }) },
      "USERINFO_ENDPOINTS.user",
    ],
    [{ ACCOUNT_ID_FIELD: "user.id" }, "ACCOUNT_ID_FIELD"],
    [{ ACCOUNT_ID_FIELD: "email" }, "ACCOUNT_ID_FIELD"],
  ])("refuses %o", (env, name) => {
    expect(() => withEnv(env)).toThrow(name);
  });
});
