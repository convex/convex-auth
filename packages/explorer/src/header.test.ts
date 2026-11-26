import { describe, expect, test } from "vitest";
import { TIMELINE_VERSION } from "./events.ts";
import { defaultAppName, recordingHeader } from "./header.ts";

describe("the recording event", () => {
  test("names the app after its directory by default", () => {
    expect(defaultAppName("/repo/examples/react-username-password")).toBe(
      "react-username-password",
    );
    expect(defaultAppName("/repo/examples/react-username-password/")).toBe(
      "react-username-password",
    );
  });

  test("holds the app, and the page and scenario only with a browser", () => {
    const base = {
      time: 1,
      app: "react-username-password",
      deploymentUrl: "http://127.0.0.1:3210",
      project: "convex-auth",
    };
    expect(recordingHeader({ ...base, page: null, scenario: null })).toEqual({
      kind: "recording",
      v: TIMELINE_VERSION,
      ...base,
    });
    expect(
      recordingHeader({
        ...base,
        page: "http://localhost:5173",
        scenario: "react-username-password",
      }),
    ).toMatchObject({
      app: "react-username-password",
      page: "http://localhost:5173",
      scenario: "react-username-password",
    });
  });
});
