import { describe, expect, test } from "vitest";
import { createLayout } from "../scene/layout.ts";
import type { Recording, Structure } from "./types.ts";
import { createWorld } from "./world.ts";

// A codebase that is not Convex Auth: a shop whose orders move through
// states. No config, no platform places: everything falls back to defaults.
const structure: Structure = {
  regions: [
    { id: "phone", kind: "client", label: "Phone", summary: "" },
    { id: "api", kind: "service", label: "API", summary: "" },
    {
      id: "billing",
      kind: "service",
      label: "Billing",
      parent: "api",
      summary: "",
    },
  ],
  places: [],
  functions: [
    {
      id: "api:order",
      region: "api",
      name: "order",
      short: "order",
      label: "order",
      type: "mutation",
      visibility: "public",
      scheduled: false,
      summary: "",
    },
    {
      id: "billing:charge",
      region: "billing",
      name: "charge",
      short: "charge",
      label: "billing.charge",
      type: "mutation",
      visibility: "internal",
      scheduled: false,
      summary: "",
    },
  ],
  tables: [
    {
      id: "api:orders",
      region: "api",
      name: "orders",
      fields: ["state"],
      summary: "",
      stateField: "state",
    },
  ],
  tokens: [{ kind: "receipt", label: "receipt", summary: "" }],
};

const recording: Recording = {
  executions: [
    {
      id: "e1",
      title: "Order",
      function: "api:order",
      caller: "phone",
      scheduled: false,
      startedAt: 0,
      endedAt: 10,
      args: {},
      steps: [
        { kind: "call", target: "billing:charge" },
        {
          kind: "return",
          target: "billing:charge",
          value: "paid",
          tone: "normal",
        },
      ],
      writes: [
        {
          table: "api:orders",
          op: "insert",
          row: "o1",
          doc: { state: "paid" },
        },
      ],
      schedules: [],
      status: "ok",
      tone: "normal",
      tokens: [{ kind: "receipt", label: "R1" }],
      drops: [],
    },
  ],
};

describe("another codebase", () => {
  const world = createWorld(structure, recording);

  test("plays through the engine", () => {
    const end = world.stateAt(world.timeline.duration);
    expect(end.tables.get("api:orders")?.[0].state).toBe("paid");
    expect(end.holdings.get("phone")?.map((k) => k.label)).toEqual(["R1"]);
    expect(world.timeline.movements.map((m) => m.kind)).toEqual([
      "request",
      "call",
      "return",
      "response",
    ]);
  });

  test("gets a layout without any config", () => {
    const layout = createLayout(structure, { title: "Shop" });
    expect([...layout.islands.keys()].sort()).toEqual([
      "api",
      "billing",
      "phone",
    ]);
    expect(layout.functions.size).toBe(2);
    expect(layout.tables.get("api:orders")?.featured).toBe(true);
    expect(layout.platform.radius).toBeGreaterThan(0);
  });
});
