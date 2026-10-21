import assert from "node:assert/strict";
import { anyApi, defineApp, defineComponent } from "convex/server";
import { v } from "convex/values";
import { auth, createUser } from "./contracts.ts";

// The SDK's own serialization tests supply this analysis-only path too.
// These casts expose the harness, not a proposed public Auth API.
(
  auth as unknown as { componentDefinitionPath: string }
).componentDefinitionPath = "./auth";
type AnalysisHarness = {
  export(): {
    childComponents: { args: [string, unknown][] }[];
  };
};
const validatorJson = (validator: unknown): unknown =>
  (validator as { json: unknown }).json;

assert.deepEqual(
  validatorJson(v.function<"mutation", { required: string }, null>()),
  { type: "function" },
);
const serializedSignature = validatorJson(createUser);
assert.ok(serializedSignature && typeof serializedSignature === "object");
assert.equal("fnType" in serializedSignature, true);
assert.equal("args" in serializedSignature, true);
assert.equal("returns" in serializedSignature, true);
console.log(
  "PASS: validator signatures serialize; generic-only signatures erase",
);

const parent = defineComponent("parent");
parent.use(auth, {
  args: {
    providers: [{ name: "password", createUser: anyApi.users.createUser }],
  },
});
const exported = (parent as unknown as AnalysisHarness).export();
assert.deepEqual(Object.fromEntries(exported.childComponents[0].args), {
  providers: {
    type: "array",
    elements: [
      {
        type: "object",
        fields: [
          ["name", { type: "value", value: '"password"' }],
          [
            "createUser",
            {
              type: "reference",
              reference: "_reference/function/users:createUser",
            },
          ],
        ],
      },
    ],
  },
});
console.log(
  "PASS: callbacks nested inside provider arrays serialize as references",
);

const app = defineApp({ env: { TTL: v.string() } });
const badParent = defineComponent("badParent");
badParent.use(auth, {
  args: {
    providers: [],
    // Deliberately bypass the type check to exercise runtime rejection.
    accessTokenTtlSeconds: app.env.TTL as unknown as number,
  },
});
assert.throws(
  () => (badParent as unknown as AnalysisHarness).export(),
  /can't be an environment variable/,
);
console.log("PASS: init arguments reject environment references");
