import { describe, expect, test } from "vitest";
import {
  deploymentUrlOf,
  keyMismatchWarning,
  parseEnvFile,
  resolveTarget,
  TargetError,
  type TargetInput,
} from "./config.ts";

const local: TargetInput = {
  target: "local",
  appVariables: {
    CONVEX_DEPLOYMENT: "anonymous:anonymous-agent",
    VITE_CONVEX_URL: "http://127.0.0.1:3210",
  },
  env: {},
  url: undefined,
  localAdminKey: "local-key",
};

describe("resolveTarget", () => {
  test("local: the URL of the app and the admin key of `npx convex dev`", () => {
    expect(resolveTarget(local)).toEqual({
      target: "local",
      url: "http://127.0.0.1:3210",
      key: "local-key",
    });
  });

  test("local: the self-hosted variables win", () => {
    expect(
      resolveTarget({
        ...local,
        appVariables: {},
        env: {
          CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:4000/",
          CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted-key",
        },
        localAdminKey: null,
      }),
    ).toEqual({
      target: "local",
      url: "http://127.0.0.1:4000",
      key: "self-hosted-key",
    });
  });

  test("local: an app on cloud needs --cloud", () => {
    expect(() =>
      resolveTarget({
        ...local,
        appVariables: {
          CONVEX_DEPLOYMENT: "dev:happy-cat-123",
          VITE_CONVEX_URL: "https://happy-cat-123.convex.cloud",
        },
        localAdminKey: null,
      }),
    ).toThrow(/--cloud/);
    expect(() => resolveTarget({ ...local, localAdminKey: null })).toThrow(
      TargetError,
    );
  });

  test("cloud: the URL of the app and CONVEX_DEPLOY_KEY", () => {
    const cloud: TargetInput = {
      target: "cloud",
      appVariables: { VITE_CONVEX_URL: "https://happy-cat-123.convex.cloud" },
      env: { CONVEX_DEPLOY_KEY: "dev:happy-cat-123|secret" },
      url: undefined,
      localAdminKey: "local-key",
    };
    expect(resolveTarget(cloud)).toEqual({
      target: "cloud",
      url: "https://happy-cat-123.convex.cloud",
      key: "dev:happy-cat-123|secret",
    });
    expect(() => resolveTarget({ ...cloud, env: {} })).toThrow(
      /CONVEX_DEPLOY_KEY/,
    );
    expect(() => resolveTarget({ ...cloud, appVariables: {} })).toThrow(
      /--url/,
    );
  });
});

test("parseEnvFile and deploymentUrlOf", () => {
  const variables = parseEnvFile(
    '# comment\nCONVEX_DEPLOYMENT=dev:a # team\nNEXT_PUBLIC_CONVEX_URL="https://a.convex.cloud/"\n',
  );
  expect(variables).toEqual({
    CONVEX_DEPLOYMENT: "dev:a",
    NEXT_PUBLIC_CONVEX_URL: "https://a.convex.cloud/",
  });
  expect(deploymentUrlOf(variables)).toBe("https://a.convex.cloud");
});

test("keyMismatchWarning", () => {
  expect(
    keyMismatchWarning("dev:a|x", "https://a.eu-west-1.convex.cloud"),
  ).toBeNull();
  expect(keyMismatchWarning("dev:b|x", "https://a.convex.cloud")).toMatch(
    /"b"/,
  );
});
