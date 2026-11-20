// @vitest-environment node
import { readFileSync } from "node:fs";
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { expect, expectTypeOf, test, vi } from "vitest";
import type {
  AuthSignInApi,
  ConvexMutationApi,
  SignInFunction,
} from "./browser/index.ts";
import type {
  ManagementFlowContext,
  SignInFlowContext,
} from "./methods/username-passkey/client.ts";

// Only the React and Next.js entries may load React. The others are for a
// backend or for a client of any framework, so they must load without it.
for (const name of [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "convex/react",
]) {
  vi.doMock(name, () => {
    throw new Error(`the entry imported ${name}`);
  });
}

const { exports } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  exports: Record<string, string | { types?: string; default?: string }>;
};

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** The source file that a target in `dist/` is compiled from. */
function source(target: string) {
  return target.replace(/^\.\/dist\//, "./").replace(/\.(d\.ts|js)$/, ".ts");
}

const entries = Object.entries(exports).flatMap(([key, target]) => {
  const file = typeof target === "string" ? target : target.default;
  if (!file?.startsWith("./dist/")) return [];
  if (/react|nextjs|convex\.config|_generated/.test(key)) return [];
  return [[key, source(file)]];
});

test.each(entries)("%s loads without React", async (_key, file) => {
  expect(modules[file]).toBeDefined();
  await modules[file]!();
});

// The entries for client libraries of other frameworks, with what each one
// exports at runtime. These names are public: add a new one here, and do not
// remove one.
const clients = {
  "./methods/oauth/client": [
    "OAUTH_ACTIONS_KEY",
    "OAUTH_FLOW_ERROR_KEY",
    "OAUTH_SETUP_ID",
    "oauth",
  ],
  "./methods/username-passkey/client": [
    "CHALLENGE_TTL_MS",
    "authenticate",
    "authenticateWithAutofill",
    "browserCeremonies",
    "foldClientError",
    "isConditionalMediationAvailable",
    "register",
    "resolveCeremonies",
    "runAddPasskeyFlow",
    "runRemovePasskeyFlow",
    "runSignInOrSignUpFlow",
    "supportsWebAuthn",
  ],
};

test.each(Object.entries(clients))(
  "%s exports its client",
  async (key, names) => {
    const target = exports[key];
    expect(target).toBeTypeOf("object");
    const { types, default: file } = target as {
      types: string;
      default: string;
    };
    // The declarations and the code are those of one module.
    expect(source(types)).toBe(source(file));
    const client = (await modules[source(file)]!()) as object;
    expect(Object.keys(client).sort()).toEqual(names);
  },
);

test("a client library types the passkey flows without React", () => {
  type SignIn = SignInFlowContext;
  type Management = ManagementFlowContext<unknown>;

  // The Convex clients of `convex/browser` run the mutations of the flows.
  expectTypeOf<ConvexClient>().toExtend<SignIn["convex"]>();
  expectTypeOf<ConvexHttpClient>().toExtend<SignIn["convex"]>();
  expectTypeOf<ConvexClient>().toExtend<Management["convex"]>();
  expectTypeOf<ConvexHttpClient>().toExtend<Management["convex"]>();
  // A client that cannot run a mutation is refused.
  expectTypeOf<Pick<ConvexClient, "query">>().not.toExtend<SignIn["convex"]>();
  expectTypeOf<Pick<ConvexClient, "query">>().not.toExtend<
    Management["convex"]
  >();

  // `@convex-dev/auth/browser` exports the types of the context.
  expectTypeOf<ConvexMutationApi>().toExtend<SignIn["convex"]>();
  expectTypeOf<AuthSignInApi>().toExtend<SignIn["signInApi"]>();
  expectTypeOf<SignInFunction<"mutation">>().toEqualTypeOf<
    Parameters<AuthSignInApi["mutation"]>[0]
  >();
});
