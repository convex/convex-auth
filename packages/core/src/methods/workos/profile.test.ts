import { describe, expect, test } from "vitest";
import { normalizeWorkosProfile } from "./server.ts";

const PROFILE = {
  id: "prof_1",
  idp_id: "00u1",
  organization_id: "org_1",
  connection_id: "conn_1",
  connection_type: "OktaSAML",
  email: "Ada@Example.com",
  first_name: "Ada",
  last_name: null,
};

describe("normalizeWorkosProfile", () => {
  test("maps the SSO profile and lowercases the email", () => {
    expect(normalizeWorkosProfile({ profile: PROFILE })).toEqual({
      id: "prof_1",
      idpId: "00u1",
      organizationId: "org_1",
      connectionId: "conn_1",
      connectionType: "OktaSAML",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: undefined,
    });
  });

  test("refuses a response with no profile", () => {
    expect(() => normalizeWorkosProfile(undefined)).toThrow(/no profile/);
  });

  test("refuses a profile with no id", () => {
    expect(() =>
      normalizeWorkosProfile({ profile: { ...PROFILE, id: "" } }),
    ).toThrow(/no id/);
  });
});
