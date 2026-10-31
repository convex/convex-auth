import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import { EVENTS } from "./constants.ts";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

const WEBHOOK_URL = "https://test.convex.site/workos/webhook";
const REGISTER = { onEvent: "function://onEvent" };

type Endpoint = {
  object: "webhook_endpoint";
  id: string;
  endpoint_url: string;
  secret: string;
  status: "enabled" | "disabled";
  events: string[];
};

/** WorkOS's `/webhook_endpoints` API, paging through `after` like WorkOS. */
class FakeEndpoints {
  endpoints: Endpoint[] = [];
  calls: string[] = [];

  add(url: string, fields: Partial<Endpoint> = {}): Endpoint {
    const endpoint: Endpoint = {
      object: "webhook_endpoint",
      id: `we_${this.endpoints.length + 1}`,
      endpoint_url: url,
      secret: `secret_${this.endpoints.length + 1}`,
      status: "enabled",
      events: [...EVENTS],
      ...fields,
    };
    this.endpoints.push(endpoint);
    return endpoint;
  }

  async respond(url: URL, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const body: unknown =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url.pathname === "/webhook_endpoints" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const after = url.searchParams.get("after");
      const start =
        after === null
          ? 0
          : this.endpoints.findIndex((item) => item.id === after) + 1;
      const data = this.endpoints.slice(start, start + limit);
      const more = start + limit < this.endpoints.length;
      return json({
        object: "list",
        data,
        list_metadata: { after: more ? data[data.length - 1]?.id : null },
      });
    }
    if (url.pathname === "/webhook_endpoints" && method === "POST") {
      const { endpoint_url, events } = body as {
        endpoint_url: string;
        events: string[];
      };
      return json(this.add(endpoint_url, { events }));
    }
    const id = url.pathname.split("/").pop();
    const endpoint = this.endpoints.find((item) => item.id === id);
    if (endpoint !== undefined && method === "PATCH") {
      Object.assign(endpoint, body);
      return json(endpoint);
    }
    if (endpoint !== undefined && method === "DELETE") {
      this.endpoints = this.endpoints.filter((item) => item !== endpoint);
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({ code: "not_found" }), {
      status: 404,
    });
  }

  install() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: string | URL | Request, init?: RequestInit) =>
          await this.respond(new URL(String(input)), init ?? {}),
      ),
    );
  }
}

function setup() {
  vi.stubEnv("CLIENT_ID", "client_1");
  vi.stubEnv("CLIENT_SECRET", "sk_test_1");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/workos");
  const workos = new FakeEndpoints();
  workos.install();
  return { t: convexTest(schema, modules), workos };
}

async function kept(t: ReturnType<typeof setup>["t"]) {
  return await t.run(async (ctx) => await ctx.db.query("webhook").collect());
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("webhook.register", () => {
  test("creates the endpoint once, subscribed to the webhook's events", async () => {
    const { t, workos } = setup();
    expect(await t.action(api.webhook.register, REGISTER)).toEqual({
      endpointId: "we_1",
      created: true,
    });
    expect(await t.action(api.webhook.register, REGISTER)).toEqual({
      endpointId: "we_1",
      created: false,
    });
    expect(workos.endpoints).toHaveLength(1);
    expect(workos.endpoints[0]?.endpoint_url).toBe(WEBHOOK_URL);
    expect(workos.endpoints[0]?.events).toEqual([...EVENTS]);
    expect(
      (await kept(t)).map(({ endpointId, url, secret, onEvent }) => ({
        endpointId,
        url,
        secret,
        onEvent,
      })),
    ).toEqual([
      {
        endpointId: "we_1",
        url: WEBHOOK_URL,
        secret: "secret_1",
        onEvent: REGISTER.onEvent,
      },
    ]);
  });

  test("finds its endpoint past the first page of other deployments' endpoints", async () => {
    const { t, workos } = setup();
    for (let i = 0; i < 150; i += 1) {
      workos.add(`https://other-${i}.convex.site/workos/webhook`);
    }
    const mine = workos.add(WEBHOOK_URL);
    expect(await t.action(api.webhook.register, REGISTER)).toEqual({
      endpointId: mine.id,
      created: false,
    });
    expect(workos.endpoints).toHaveLength(151);
    expect(workos.calls).toEqual([
      "GET /webhook_endpoints",
      "GET /webhook_endpoints",
    ]);
    expect((await kept(t)).map((row) => row.secret)).toEqual([mine.secret]);
  });

  test("enables a disabled endpoint and subscribes it to missing events", async () => {
    const { t, workos } = setup();
    const endpoint = workos.add(WEBHOOK_URL, {
      status: "disabled",
      events: ["user.created", "dsync.user.created"],
    });
    await t.action(api.webhook.register, REGISTER);
    expect(endpoint.status).toBe("enabled");
    expect(new Set(endpoint.events)).toEqual(
      new Set(["user.created", ...EVENTS]),
    );
    expect(workos.calls).toContain(`PATCH /webhook_endpoints/${endpoint.id}`);
  });

  test("keeps no secret when WorkOS refuses", async () => {
    const { t } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(t.action(api.webhook.register, REGISTER)).rejects.toThrow(
      /401/,
    );
    expect(await kept(t)).toEqual([]);
  });
});

describe("webhook.unregister", () => {
  test("refuses an onEvent that is not a function handle", async () => {
    const { t, workos } = setup();
    await expect(
      t.action(api.webhook.register, { onEvent: "testApp:onEvent" }),
    ).rejects.toThrow(/function handle/);
    expect(workos.endpoints).toEqual([]);
  });

  test("deletes this deployment's endpoint and its secret, and nothing else", async () => {
    const { t, workos } = setup();
    const other = workos.add(
      "https://other-otter-1.convex.site/workos/webhook",
    );
    await t.action(api.webhook.register, REGISTER);
    expect(await t.action(api.webhook.unregister, {})).toEqual({
      deleted: true,
    });
    expect(workos.endpoints).toEqual([other]);
    expect(await kept(t)).toEqual([]);
  });

  test("finds its endpoint by URL when no row is kept", async () => {
    const { t, workos } = setup();
    workos.add(WEBHOOK_URL);
    expect(await t.action(api.webhook.unregister, {})).toEqual({
      deleted: true,
    });
    expect(workos.endpoints).toEqual([]);
  });

  test("counts an endpoint WorkOS no longer has as gone", async () => {
    const { t, workos } = setup();
    await t.action(api.webhook.register, REGISTER);
    workos.endpoints = [];
    expect(await t.action(api.webhook.unregister, {})).toEqual({
      deleted: false,
    });
    expect(await kept(t)).toEqual([]);
  });

  test("keeps the row when WorkOS refuses", async () => {
    const { t } = setup();
    await t.action(api.webhook.register, REGISTER);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(t.action(api.webhook.unregister, {})).rejects.toThrow(/401/);
    expect(await kept(t)).toHaveLength(1);
  });
});
