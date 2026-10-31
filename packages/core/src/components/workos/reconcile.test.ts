import { convexTest } from "convex-test";
import {
  createFunctionHandle,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.ts";
import schema, { vWorkosEvent } from "./schema.ts";
import type { WorkosEvent } from "./schema.ts";
import { decodeObject } from "./wire.ts";

const modules = import.meta.glob("./**/*.ts");

type Json = Record<string, unknown>;

/**
 * A WorkOS environment, as much of its API as the copy reads: listings that
 * page through `after`, and reads by id. `failures` answers the next calls
 * with those statuses first.
 */
class FakeWorkos {
  organizations: Json[] = [];
  connections: Json[] = [];
  directories: Json[] = [];
  users: Json[] = [];
  groups: Json[] = [];
  failures: number[] = [];
  calls: string[] = [];
  now = Date.parse("2026-01-01T00:00:00Z");

  private page(items: Json[], params: URLSearchParams) {
    const limit = Number(params.get("limit") ?? "10");
    const after = params.get("after");
    const start =
      after === null ? 0 : items.findIndex((item) => item.id === after) + 1;
    const data = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return {
      object: "list",
      data,
      list_metadata: { after: more ? data[data.length - 1]?.id : null },
    };
  }

  private byId(collection: string, id: string): Json | undefined {
    const domains = this.organizations.flatMap((organization) =>
      Array.isArray(organization.domains)
        ? organization.domains.map((domain: Json) => ({
            updated_at: organization.updated_at,
            ...domain,
            organization_id: organization.id,
          }))
        : [],
    );
    const held: Record<string, Json[]> = {
      organizations: this.organizations,
      organization_domains: domains,
      connections: this.connections,
      directories: this.directories,
      directory_users: this.users,
      directory_groups: this.groups,
    };
    return held[collection]?.find((item) => item.id === id);
  }

  respond(url: URL): Response {
    this.calls.push(url.pathname);
    const params = url.searchParams;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { Date: new Date(this.now).toUTCString() },
      });
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return new Response(JSON.stringify({ code: "unavailable" }), {
        status: failure,
        headers: failure === 429 ? { "Retry-After": "2" } : {},
      });
    }
    const [, collection, id] = url.pathname.split("/");
    if (collection !== undefined && id !== undefined) {
      const found = this.byId(collection, decodeURIComponent(id));
      return found === undefined
        ? json({ code: "entity_not_found" }, 404)
        : json(found);
    }
    switch (url.pathname) {
      case "/organizations":
        return json(this.page(this.organizations, params));
      case "/connections":
        return json(this.page(this.connections, params));
      case "/directories":
        return json(this.page(this.directories, params));
      case "/directory_users":
        return json(
          this.page(
            this.users.filter(
              (user) => user.directory_id === params.get("directory"),
            ),
            params,
          ),
        );
      case "/directory_groups":
        return json(
          this.page(
            this.groups.filter(
              (group) => group.directory_id === params.get("directory"),
            ),
            params,
          ),
        );
      default:
        return json({ code: "not_found" }, 404);
    }
  }
}

const at = (ms: number) => new Date(ms).toISOString();

function organization(id: string, domains: string[], updated = 0): Json {
  return {
    object: "organization",
    id,
    name: `Org ${id}`,
    domains: domains.map((domain, index) => ({
      id: `org_domain_${id}_${index}`,
      domain,
      state: "verified",
    })),
    updated_at: at(updated),
  };
}

function user(
  id: string,
  state = "active",
  updated = 0,
  role = "member",
): Json {
  return {
    object: "directory_user",
    id,
    directory_id: "directory_1",
    organization_id: "org_1",
    idp_id: `idp_${id}`,
    email: `${id}@example.com`,
    first_name: "First",
    last_name: "Last",
    state,
    role: { slug: role },
    roles: [{ slug: role }],
    updated_at: at(updated),
  };
}

function group(id: string, updated = 0): Json {
  return {
    object: "directory_group",
    id,
    directory_id: "directory_1",
    organization_id: "org_1",
    name: `Group ${id}`,
    updated_at: at(updated),
  };
}

const DIRECTORY = {
  object: "directory",
  id: "directory_1",
  organization_id: "org_1",
  name: "Okta",
  type: "okta scim v2.0",
  state: "linked",
  updated_at: at(0),
};

const WEBHOOK_SECRET = "webhook-secret";

let events: WorkosEvent[] = [];
let refuse: ((event: WorkosEvent) => boolean) | undefined;

const onEvent = makeFunctionReference<"mutation", { event: WorkosEvent }, null>(
  "testApp:onEvent",
);

const register = makeFunctionReference<"mutation", Record<string, never>, null>(
  "testApp:register",
);

const testApp = {
  onEvent: internalMutationGeneric({
    args: { event: vWorkosEvent },
    returns: v.null(),
    handler: async (_ctx, args) => {
      if (refuse?.(args.event) === true) {
        throw new Error("the app refused the change");
      }
      events.push(args.event);
      return null;
    },
  }),
  register: mutationGeneric({
    args: {},
    returns: v.null(),
    handler: async (ctx) => {
      await ctx.db.insert("webhook", {
        endpointId: "we_1",
        url: "https://test.convex.site/workos/webhook",
        secret: WEBHOOK_SECRET,
        onEvent: await createFunctionHandle(onEvent),
      });
      return null;
    },
  }),
};

function setup(workos: FakeWorkos) {
  vi.stubEnv("CLIENT_ID", "client_1");
  vi.stubEnv("CLIENT_SECRET", "sk_test_1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      workos.respond(new URL(String(input))),
    ),
  );
  return convexTest(schema, {
    ...modules,
    "./testApp.ts": async () => testApp,
  });
}

async function reconcile(t: ReturnType<typeof setup>) {
  await t.mutation(api.reconcile.start, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function sign(body: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `t=${timestamp}, v1=${hex}`;
}

/** Deliver one event to the webhook, signed as WorkOS signs it. */
async function deliver(
  t: ReturnType<typeof setup>,
  event: string,
  data: Json,
): Promise<number> {
  vi.advanceTimersByTime(1000);
  const body = JSON.stringify({
    object: "event",
    id: `event_${event}`,
    event,
    data,
    created_at: new Date(Date.now()).toISOString(),
  });
  const response = await t.fetch("/webhook", {
    method: "POST",
    headers: { "WorkOS-Signature": await sign(body, Date.now()) },
    body,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  return response.status;
}

function seeded(): FakeWorkos {
  const workos = new FakeWorkos();
  workos.organizations = [organization("org_1", ["example.com"])];
  workos.connections = [
    {
      object: "connection",
      id: "conn_1",
      organization_id: "org_1",
      connection_type: "OktaSAML",
      state: "active",
      updated_at: at(0),
    },
  ];
  workos.directories = [DIRECTORY];
  workos.users = [user("directory_user_1"), user("directory_user_2")];
  workos.groups = [group("directory_group_1")];
  return workos;
}

async function prepared(workos: FakeWorkos) {
  const t = setup(workos);
  await t.mutation(register, {});
  await reconcile(t);
  events = [];
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
  events = [];
  refuse = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const names = () => events.map((event) => event.event);

describe("reconcile", () => {
  test("refuses to start before the webhook is registered", async () => {
    const t = setup(seeded());
    await expect(t.mutation(api.reconcile.start, {})).rejects.toThrow(
      /Register the webhook/,
    );
  });

  test("the first run lists everything and tells the app", async () => {
    const t = setup(seeded());
    await t.mutation(register, {});
    await reconcile(t);

    expect(names()).toEqual([
      "organization.created",
      "organization_domain.created",
      "connection.activated",
      "dsync.activated",
      "dsync.user.created",
      "dsync.user.created",
      "dsync.group.created",
    ]);
    expect(
      await t.query(api.organizationDomains.get, { domain: "Ada@EXAMPLE.com" }),
    ).toMatchObject({
      organization: { id: "org_1" },
      connection: { id: "conn_1", connectionType: "OktaSAML" },
    });
    expect(
      await t.query(api.organizationDomains.get, { domain: "elsewhere.com" }),
    ).toBeNull();
    expect(
      await t.query(api.directoryUsers.list, {
        organization: "org_1",
        idpId: "idp_directory_user_1",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).toMatchObject({
      page: [
        { id: "directory_user_1", state: "active", role: { slug: "member" } },
      ],
    });
    expect(
      await t.query(api.directoryGroups.list, {
        directory: "directory_1",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).toMatchObject({ page: [{ id: "directory_group_1" }] });
  });

  test("a second run with nothing new changes nothing", async () => {
    const t = await prepared(seeded());
    vi.advanceTimersByTime(1000);
    await reconcile(t);
    expect(events).toEqual([]);
  });

  test("removes what the listings no longer show", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    workos.users = [user("directory_user_1")];
    workos.connections = [];
    vi.advanceTimersByTime(1000);
    await reconcile(t);

    expect(names()).toEqual(["dsync.user.deleted", "connection.deleted"]);
    expect(events[0]).toMatchObject({ data: { id: "directory_user_2" } });
  });

  test("pages through a listing longer than a page", async () => {
    const workos = seeded();
    workos.users = Array.from({ length: 120 }, (_, index) =>
      user(`directory_user_${String(index).padStart(3, "0")}`),
    );
    const t = setup(workos);
    await t.mutation(register, {});
    await reconcile(t);
    expect(
      names().filter((name) => name === "dsync.user.created"),
    ).toHaveLength(120);
    const listed: string[] = [];
    let cursor: string | null = null;
    for (let done = false; !done;) {
      const page: {
        page: { id: string }[];
        isDone: boolean;
        continueCursor: string;
      } = await t.query(api.directoryUsers.list, {
        directory: "directory_1",
        paginationOpts: { numItems: 50, cursor },
      });
      listed.push(...page.page.map((row) => row.id));
      cursor = page.continueCursor;
      done = page.isDone;
    }
    expect(listed).toEqual(workos.users.map((row) => row.id));
  });

  test("an overlapping older reconcile never makes a newer one remove a listed user", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const older = Date.now();
    vi.advanceTimersByTime(1000);
    const newer = Date.now();
    await t.action(internal.reconcile.run, {
      generation: newer,
      step: { stage: "organizations" },
    });
    await t.action(internal.reconcile.run, {
      generation: older,
      step: { stage: "organizations" },
    });
    await t.action(internal.reconcile.run, {
      generation: newer,
      step: { stage: "prune", kind: "directoryUser" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(events).toEqual([]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_2" }),
    ).toMatchObject({ state: "active" });
  });

  test("tries the same step again after WorkOS's Retry-After", async () => {
    const workos = seeded();
    workos.failures = [429];
    const t = setup(workos);
    await t.mutation(register, {});
    await reconcile(t);
    expect(
      names().filter((name) => name === "dsync.user.created"),
    ).toHaveLength(2);
    expect(workos.calls.slice(0, 2)).toEqual([
      "/organizations",
      "/organizations",
    ]);
  });

  test("ends the run on a failure that names no Retry-After", async () => {
    const workos = seeded();
    workos.failures = [503];
    const t = setup(workos);
    await t.mutation(register, {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcile(t).catch(() => undefined);
    expect(events).toEqual([]);
    expect(workos.calls).toEqual(["/organizations"]);
  });
});

describe("webhook deliveries", () => {
  test("a delivery reads the object again, so order does not matter", async () => {
    const workos = seeded();
    const t = await prepared(workos);

    workos.users[0] = user("directory_user_1", "inactive", 3);
    for (const delivered of [
      user("directory_user_1", "inactive", 2),
      user("directory_user_1", "inactive", 3),
      user("directory_user_1", "active", 2.5),
    ]) {
      expect(await deliver(t, "dsync.user.updated", delivered)).toBe(200);
    }

    expect(events).toEqual([
      {
        event: "dsync.user.updated",
        data: expect.objectContaining({
          id: "directory_user_1",
          state: "inactive",
        }),
      },
    ]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_1" }),
    ).toMatchObject({ state: "inactive" });
  });

  test("a membership change reads the directory user again, with its roles", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const membership = {
      directory_id: "directory_1",
      user: user("directory_user_1"),
      group: group("directory_group_1"),
    };

    workos.users[0] = user("directory_user_1", "active", 4, "lead");
    expect(await deliver(t, "dsync.group.user_added", membership)).toBe(200);
    expect(await deliver(t, "dsync.group.user_added", membership)).toBe(200);

    expect(events).toEqual([
      {
        event: "dsync.user.updated",
        data: expect.objectContaining({
          id: "directory_user_1",
          role: { slug: "lead" },
          roles: [{ slug: "lead" }],
        }),
      },
    ]);
  });

  test("a deletion before the first write, and a late create after it, leave nothing", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const gone = user("directory_user_9");

    expect(await deliver(t, "dsync.user.deleted", gone)).toBe(200);
    expect(await deliver(t, "dsync.user.created", gone)).toBe(200);

    expect(events).toEqual([]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_9" }),
    ).toBeNull();
  });

  test("a read that commits late never overwrites a newer one", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const late = decodeObject(
      "directoryUser",
      user("directory_user_1", "active", 2),
    );

    workos.users[0] = user("directory_user_1", "inactive", 3);
    expect(await deliver(t, "dsync.user.updated", workos.users[0])).toBe(200);
    await t.mutation(internal.reconcile.settle, {
      kind: "directoryUser",
      updates: [late],
      gone: [],
    });
    await t.mutation(internal.reconcile.page, {
      generation: Date.now(),
      position: { stage: "directoryUsers", directoryId: "directory_1" },
      updates: [late],
      after: "directory_user_1",
    });

    expect(events).toMatchObject([
      { event: "dsync.user.updated", data: { state: "inactive" } },
    ]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_1" }),
    ).toMatchObject({ state: "inactive" });
  });

  test("a read from before a deletion never brings the object back", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const late = decodeObject("directoryUser", user("directory_user_1"));
    const domain = decodeObject(
      "organization",
      organization("org_1", ["example.com"]),
    );

    workos.users = [user("directory_user_2")];
    workos.organizations = [organization("org_1", [], 1)];
    expect(
      await deliver(t, "dsync.user.deleted", user("directory_user_1")),
    ).toBe(200);
    expect(
      await deliver(t, "organization.updated", workos.organizations[0]),
    ).toBe(200);
    await t.mutation(internal.reconcile.settle, {
      kind: "directoryUser",
      updates: [late],
      gone: [],
    });
    await t.mutation(internal.reconcile.settle, {
      kind: "organization",
      updates: [domain],
      gone: [],
    });

    expect(names()).toEqual([
      "dsync.user.deleted",
      "organization_domain.deleted",
    ]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_1" }),
    ).toBeNull();
    expect(
      await t.query(api.directoryUsers.list, {
        directory: "directory_1",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).toMatchObject({ page: [{ id: "directory_user_2" }] });
    expect(
      await t.query(api.organizationDomains.get, { domain: "example.com" }),
    ).toBeNull();
  });

  test("a read from before a directory's deletion never brings it or its users back", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const directory = decodeObject("directory", DIRECTORY);
    const member = decodeObject("directoryUser", user("directory_user_1"));
    workos.directories = [];
    workos.users = [];
    workos.groups = [];

    await deliver(t, "dsync.deleted", { ...DIRECTORY, state: "deleting" });
    events = [];
    await t.mutation(internal.reconcile.settle, {
      kind: "directory",
      updates: [directory],
      gone: [],
    });
    await t.mutation(internal.reconcile.page, {
      generation: Date.now(),
      position: { stage: "directoryUsers", directoryId: "directory_1" },
      updates: [member],
      after: "directory_user_1",
    });

    expect(events).toEqual([]);
    expect(
      await t.query(api.directories.get, { id: "directory_1" }),
    ).toBeNull();
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_1" }),
    ).toBeNull();
  });

  test("an older organization read never removes a domain WorkOS updated since", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const older = decodeObject("organization", organization("org_1", [], 1));

    workos.organizations = [organization("org_1", ["example.com"], 2)];
    expect(
      await deliver(t, "organization_domain.updated", {
        id: "org_domain_org_1_0",
        organization_id: "org_1",
      }),
    ).toBe(200);
    await t.mutation(internal.reconcile.settle, {
      kind: "organization",
      updates: [older],
      gone: [],
    });

    expect(
      await t.query(api.organizationDomains.get, { domain: "example.com" }),
    ).toMatchObject({ organization: { id: "org_1" } });
  });

  test("a deletion of an object the copy never held keeps a read from before it out", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    const late = decodeObject("directoryUser", user("directory_user_9"));

    expect(
      await deliver(t, "dsync.user.deleted", user("directory_user_9")),
    ).toBe(200);
    await t.mutation(internal.reconcile.settle, {
      kind: "directoryUser",
      updates: [late],
      gone: [],
    });

    expect(events).toEqual([]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_9" }),
    ).toBeNull();
  });

  test("a deleted directory takes its users and groups with it", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    workos.directories = [];

    await deliver(t, "dsync.deleted", { ...DIRECTORY, state: "deleting" });

    expect(names()).toEqual([
      "dsync.deleted",
      "dsync.user.deleted",
      "dsync.user.deleted",
      "dsync.group.deleted",
    ]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_1" }),
    ).toBeNull();
    expect(
      await t.query(api.directories.get, { id: "directory_1" }),
    ).toBeNull();
  });

  test("a deleted directory of 301 users is removed in batches", async () => {
    const workos = seeded();
    workos.users = Array.from({ length: 301 }, (_, index) =>
      user(`directory_user_${String(index).padStart(3, "0")}`),
    );
    const t = await prepared(workos);
    workos.directories = [];
    workos.users = [];
    workos.groups = [];

    await deliver(t, "dsync.deleted", { ...DIRECTORY, state: "deleting" });

    expect(
      names().filter((name) => name === "dsync.user.deleted"),
    ).toHaveLength(301);
    expect(names()[0]).toBe("dsync.deleted");
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("directoryUsers").collect()).length,
      ),
    ).toBe(0);
  });

  test("a refused change fails the delivery, and its retry applies it", async () => {
    const workos = seeded();
    const t = await prepared(workos);
    vi.spyOn(console, "error").mockImplementation(() => {});
    refuse = (event) =>
      event.event === "dsync.user.updated" &&
      event.data.id === "directory_user_1";

    workos.users[0] = user("directory_user_1", "inactive", 5);
    const data = user("directory_user_1", "inactive", 5);
    expect(await deliver(t, "dsync.user.updated", data).catch(() => 500)).toBe(
      500,
    );
    expect(events).toEqual([]);
    expect(
      await t.query(api.directoryUsers.get, { id: "directory_user_1" }),
    ).toMatchObject({ state: "active" });

    refuse = undefined;
    expect(await deliver(t, "dsync.user.updated", data)).toBe(200);
    expect(events).toMatchObject([
      { event: "dsync.user.updated", data: { state: "inactive" } },
    ]);
  });
});
