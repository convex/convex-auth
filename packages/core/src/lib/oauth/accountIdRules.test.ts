import { describe, expect, test } from "vitest";
import { subClaimAccountId, userInfoFieldAccountId } from "./dbHelpers.ts";

describe("account id rules", () => {
  test("subClaimAccountId reads the `sub` claim", () => {
    expect(subClaimAccountId({ claims: { sub: "abc" } })).toBe("abc");
    expect(() => subClaimAccountId({ claims: {} })).toThrow("`sub`");
    expect(() => subClaimAccountId({})).toThrow("`sub`");
  });

  test("userInfoFieldAccountId reads a field of a userinfo response", () => {
    const githubId = userInfoFieldAccountId("user", "id");
    expect(githubId({ userInfoResponses: { user: { id: 583231 } } })).toBe(
      "583231",
    );
    expect(githubId({ userInfoResponses: { user: { id: "u-1" } } })).toBe(
      "u-1",
    );
    expect(() =>
      githubId({ userInfoResponses: { user: { login: "alice" } } }),
    ).toThrow("has no `id` field");
    expect(() =>
      githubId({ userInfoResponses: { user: { id: 1.5 } } }),
    ).toThrow("has no `id` field");
    expect(() => githubId({})).toThrow("has no `id` field");
  });
});
