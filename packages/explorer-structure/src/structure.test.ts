import { describe, expect, test } from "vitest";
import { structure } from "./index.ts";
import type { ConvexAuthStructure } from "./convex-auth/model.ts";

type Part = ConvexAuthStructure["parts"][number];
type Dependency = ConvexAuthStructure["dependencies"][number];
type DependencyKind = Dependency["kind"];

const parts = new Map(structure.parts.map((part) => [part.id, part]));

function part(id: string): Part {
  const found = parts.get(id);
  if (found === undefined) {
    throw new Error(`No part ${id}`);
  }
  return found;
}

function dependencies(
  filter: Partial<Pick<Dependency, "kind" | "from" | "to">>,
): Dependency[] {
  return structure.dependencies.filter(
    (d) =>
      (filter.kind === undefined || d.kind === filter.kind) &&
      (filter.from === undefined || d.from === filter.from) &&
      (filter.to === undefined || d.to === filter.to),
  );
}

function targets(kind: DependencyKind, from: string): string[] {
  return [
    ...new Set(
      dependencies({ kind, from })
        .filter((d) => d.app === undefined)
        .map((d) => d.to),
    ),
  ].sort();
}

function childrenOf(parent: string, kind: Part["kind"]): string[] {
  return structure.parts
    .filter((p) => p.parent === parent && p.kind === kind)
    .map((p) => p.name)
    .sort();
}

describe("the model", () => {
  test("gives every part a unique id and an existing parent", () => {
    expect(parts.size).toBe(structure.parts.length);
    for (const p of structure.parts) {
      if (p.parent !== null) {
        expect(parts.has(p.parent), `${p.id} → ${p.parent}`).toBe(true);
      }
    }
  });

  test("links every dependency to existing parts, with evidence", () => {
    for (const d of structure.dependencies) {
      expect(parts.has(d.from), d.from).toBe(true);
      expect(parts.has(d.to), d.to).toBe(true);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
  });

  test("counts what it holds", () => {
    const total = (counts: Partial<Record<string, number>>) =>
      Object.values(counts).reduce((a, b) => a! + b!, 0);
    expect(total(structure.counts.parts)).toBe(structure.parts.length);
    expect(total(structure.counts.dependencies)).toBe(
      structure.dependencies.length,
    );
    expect(total(structure.counts.unresolved)).toBe(
      structure.unresolved.length,
    );
  });
});

describe("the core component", () => {
  test("has its four tables", () => {
    expect(childrenOf("component:auth", "table")).toEqual([
      "createdUserIds",
      "refreshTokens",
      "sessions",
      "ttlConfig",
    ]);
  });

  test("reads the fields and indexes of refreshTokens from the schema", () => {
    const table = part("table:auth.refreshTokens");
    expect(table.kind === "table" && table.fields).toEqual([
      { name: "hash", type: "string", optional: false },
      { name: "sessionId", type: 'Id<"sessions">', optional: false },
      {
        name: "state",
        type: '"issued" | "redeemed" | "spent" | "dropped"',
        optional: false,
      },
      { name: "retiredAt", type: "number", optional: true },
    ]);
    expect(table.kind === "table" && table.indexes).toEqual([
      { name: "by_hash", fields: ["hash"] },
      { name: "by_session_state", fields: ["sessionId", "state", "retiredAt"] },
    ]);
  });

  test("public.refresh is a public mutation that writes refreshTokens", () => {
    const refresh = part("fn:auth:public.refresh");
    expect(
      refresh.kind === "function" && [refresh.functionType, refresh.visibility],
    ).toEqual(["mutation", "public"]);
    expect(targets("writes", "fn:auth:public.refresh")).toContain(
      "table:auth.refreshTokens",
    );
  });

  test("schedules sessions.deleteSessionTokens", () => {
    const scheduled = dependencies({
      kind: "schedules",
      to: "fn:auth:sessions.deleteSessionTokens",
    });
    expect(scheduled.map((d) => d.from)).toContain("fn:auth:public.signOut");
    expect(scheduled[0]!.evidence).toContainEqual({
      file: "packages/core/src/component/sessions.ts",
      line: 153,
    });
  });
});

describe("child components", () => {
  test("the email component uses the rate limiter and the batch worker", () => {
    expect(targets("usesComponent", "component:authEmail")).toEqual([
      "component:authEmail/batchWorker",
      "component:authEmail/rateLimiter",
    ]);
  });

  test("the password component uses the rate limiter", () => {
    expect(targets("usesComponent", "component:authPassword")).toEqual([
      "component:authPassword/rateLimiter",
    ]);
    // `rateLimiter.limit(ctx, "verifyPassword", …)` in components/password/public.ts.
    expect(
      dependencies({
        kind: "callsChildComponent",
        from: "fn:authPassword:public.verifyPassword",
        to: "component:authPassword/rateLimiter",
      })[0]?.via,
    ).toEqual(["limit"]);
  });
});

describe("components from npm", () => {
  test("come with their tables, read from the source they ship", () => {
    const table = part("table:authPassword/rateLimiter.rateLimits");
    expect(table.parent).toBe("component:authPassword/rateLimiter");
    expect(table.source?.file).toMatch(
      /^@convex-dev\/rate-limiter@[^/]+\/src\/component\/schema\.ts$/,
    );
    expect(childrenOf("component:authEmail/batchWorker", "table")).toEqual([
      "workerState",
      "workers",
    ]);
  });

  test("each instance has its own functions and table accesses", () => {
    expect(
      targets("writes", "fn:authPassword/rateLimiter:lib.rateLimit"),
    ).toEqual(["table:authPassword/rateLimiter.rateLimits"]);
    expect(targets("writes", "fn:authEmail/rateLimiter:lib.rateLimit")).toEqual(
      ["table:authEmail/rateLimiter.rateLimits"],
    );
  });

  test("mount their own children", () => {
    expect(targets("usesComponent", "component:resend")).toEqual([
      "component:resend/callbackWorkpool",
      "component:resend/emailWorkpool",
      "component:resend/rateLimiter",
    ]);
  });
});

describe("sign-in methods", () => {
  test("signInWithUsernamePassword calls what it calls, and nothing it does not", () => {
    expect(
      targets("calls", "methodFn:username-password.signInWithUsernamePassword"),
    ).toEqual([
      "fn:auth:public._internal_dangerous_signIn",
      "fn:authPassword:public.verifyPassword",
      "fn:authUsername:public.getUserIdByUsername",
    ]);
  });

  test("the example's app function is the one the method returns", () => {
    expect(
      targets(
        "definedBy",
        "fn:app:react-username-password:auth.signInWithUsernamePassword",
      ),
    ).toEqual(["methodFn:username-password.signInWithUsernamePassword"]);
  });

  test("the hook calls the app function the example passes it", () => {
    const calls = dependencies({
      kind: "clientCalls",
      from: "hook:methods/username-password/react.useSignInWithUsernamePassword",
      to: "fn:app:react-username-password:auth.signInWithUsernamePassword",
    });
    expect(calls.map((d) => d.app)).toEqual(["react-username-password"]);
  });
});

describe("OAuth", () => {
  test("serves the callback over the methods each provider uses", () => {
    expect(childrenOf("component:authApple", "httpRoute")).toEqual([
      "POST /callback",
    ]);
    expect(childrenOf("component:authGoogle", "httpRoute")).toEqual([
      "GET /callback",
    ]);
    expect(childrenOf("component:authOauth", "httpRoute")).toEqual([
      "GET /callback",
      "POST /callback",
    ]);
  });

  test("the Google callback exchanges the code at Google's token endpoint", () => {
    const [route] = dependencies({
      kind: "routesTo",
      from: "route:authGoogle:GET /callback",
    });
    expect(route?.to).toBe("httpAction:authGoogle:/callback");
    const fetches = dependencies({ kind: "fetches", from: route!.to });
    expect(fetches.map((d) => [d.to, d.via])).toEqual([
      ["thirdParty:google", ["oauth2.googleapis.com"]],
    ]);
  });

  test("declares the env vars of the Google component", () => {
    expect(childrenOf("component:authGoogle", "envVar")).toEqual([
      "CLIENT_ID",
      "CLIENT_SECRET",
    ]);
  });
});

describe("example apps", () => {
  test("react-username-password mounts auth, authPassword, and authUsername", () => {
    expect(targets("mounts", "app:react-username-password")).toEqual([
      "component:auth",
      "component:authPassword",
      "component:authUsername",
    ]);
  });

  test("react-email-password mounts Resend, which reaches Resend's API", () => {
    expect(targets("mounts", "app:react-email-password")).toContain(
      "component:resend",
    );
    // Read from the source the package ships: the function that sends a batch.
    expect(targets("fetches", "fn:resend:lib.callResendAPIWithBatch")).toEqual([
      "thirdParty:resend",
    ]);
  });
});

describe("the layers", () => {
  // The generic layer reads any Convex project; only the Convex Auth layer
  // may know this repository.
  const generic = import.meta.glob<string>(
    // The tests run the generic layer on this repository's examples.
    ["./generate/convex/*.ts", "!./generate/convex/*.test.ts"],
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  );

  test("the generic layer knows nothing of Convex Auth", () => {
    expect(Object.keys(generic).length).toBeGreaterThan(0);
    for (const [file, text] of Object.entries(generic)) {
      expect(text, file).not.toMatch(
        /convex-auth|@convex-dev\/auth|examples\/|packages\/core/,
      );
    }
  });

  test("the model names the layer that produced it", () => {
    expect(structure.project).toBe("convex-auth");
  });
});
