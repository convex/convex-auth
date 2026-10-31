/**
 * Writing updates, from webhook deliveries and from reconcile's listings,
 * into the copy, and telling the app about each change as the WorkOS event
 * it is.
 *
 * @module
 */
import type { FunctionHandle } from "convex/server";
import { internal } from "./_generated/api.ts";
import type { Id } from "./_generated/dataModel.ts";
import type { MutationCtx } from "./_generated/server.ts";
import type {
  Connection,
  Directory,
  DirectoryGroup,
  DirectoryUser,
  Organization,
  OrganizationDomain,
  WorkosEvent,
} from "./schema.ts";
import type { DomainUpdate, Kind, Update } from "./wire.ts";

/** The app's event handler, as the copy calls it. */
export type EventHandler = FunctionHandle<
  "mutation",
  { event: WorkosEvent },
  null
>;

/**
 * A stored handle as the {@link EventHandler} it is. Function handles are
 * strings that Convex brands, and a stored one loses the brand; Convex mints
 * them with this scheme.
 */
export function eventHandler(value: string): EventHandler {
  if (!isHandle(value)) throw new Error("onEvent must be a function handle");
  return value;
}

function isHandle(value: string): value is EventHandler {
  return value.startsWith("function://");
}

export function organizationOf({
  id,
  name,
  externalId,
}: Organization): Organization {
  return { id, name, externalId };
}

export function domainOf({
  id,
  organizationId,
  domain,
  state,
}: OrganizationDomain): OrganizationDomain {
  return { id, organizationId, domain, state };
}

export function connectionOf({
  id,
  organizationId,
  connectionType,
  name,
  state,
}: Connection): Connection {
  return { id, organizationId, connectionType, name, state };
}

export function directoryOf({
  id,
  organizationId,
  name,
  type,
  state,
}: Directory): Directory {
  return { id, organizationId, name, type, state };
}

export function userOf({
  id,
  directoryId,
  organizationId,
  idpId,
  email,
  firstName,
  lastName,
  state,
  role,
  roles,
}: DirectoryUser): DirectoryUser {
  return {
    id,
    directoryId,
    organizationId,
    idpId,
    email,
    firstName,
    lastName,
    state,
    role,
    roles,
  };
}

export function groupOf({
  id,
  directoryId,
  organizationId,
  idpId,
  name,
}: DirectoryGroup): DirectoryGroup {
  return { id, directoryId, organizationId, idpId, name };
}

/**
 * One page of rows read in `id` order, from after the cursor, which is the
 * last id of the page before, without the removed ones. Components cannot use
 * Convex's `paginate`.
 */
export async function pageOf<Row extends { id: string }, Item>(
  rows: { take(n: number): Promise<Row[]> },
  numItems: number,
  convert: (row: Row) => Item | null,
) {
  const taken = await rows.take(numItems + 1);
  const page = taken.slice(0, numItems);
  return {
    page: page.flatMap((row) => {
      const item = convert(row);
      return item === null ? [] : [item];
    }),
    isDone: taken.length <= numItems,
    continueCursor: page.at(-1)?.id ?? "",
  };
}

/** Whether two values hold the same JSON, whatever their keys' order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) ||
    Array.isArray(b)
  ) {
    return false;
  }
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = new Map(
    Object.entries(b).filter(([, value]) => value !== undefined),
  );
  return (
    left.length === right.size &&
    left.every(([key, value]) => same(value, right.get(key)))
  );
}

/**
 * Whether a read of version `updatedAt` may replace `row`: a removed object,
 * or one in a removed directory, is never written back, and an older version
 * never replaces a newer one.
 */
function supersedes(
  row: { updatedAt: string } | { deleted: true } | null,
  updatedAt: string,
  directory: object | null = null,
): boolean {
  if (directory !== null && "deleted" in directory) return false;
  if (row === null) return true;
  return (
    !("deleted" in row) && Date.parse(row.updatedAt) <= Date.parse(updatedAt)
  );
}

type Table =
  | "organizations"
  | "organizationDomains"
  | "connections"
  | "directories"
  | "directoryUsers"
  | "directoryGroups";

/**
 * The copy, inside one mutation. Every write stamps its row with
 * `generation`, the time it was read or the start of the reconcile that
 * listed it, and WorkOS's `updated_at`, and every change runs the app's
 * handler in the same transaction, so the copy and the app never disagree.
 */
export class Mirror {
  constructor(
    private readonly ctx: MutationCtx,
    private readonly generation: number,
    private readonly onEvent: EventHandler,
  ) {}

  /** Tell the app about one change. */
  async emit(event: WorkosEvent): Promise<void> {
    await this.ctx.runMutation(this.onEvent, { event });
  }

  async write(update: Update): Promise<void> {
    switch (update.kind) {
      case "organization":
        return await this.organization(update);
      case "organizationDomain":
        return await this.domain(update);
      case "connection":
        return await this.connection(update);
      case "directory":
        return await this.directory(update);
      case "directoryUser":
        return await this.user(update);
      case "directoryGroup":
        return await this.group(update);
    }
  }

  /**
   * Record that WorkOS no longer has an object, whether or not the copy
   * holds it, and tell the app if it did.
   */
  async remove(kind: Kind, id: string): Promise<void> {
    const db = this.ctx.db;
    switch (kind) {
      case "organization": {
        const row = await db
          .query("organizations")
          .withIndex("id", (q) => q.eq("id", id))
          .unique();
        if (row === null) return await this.bury("organizations", id);
        if (!("deleted" in row)) await this.removeOrganization(row);
        return;
      }
      case "organizationDomain": {
        const row = await db
          .query("organizationDomains")
          .withIndex("id", (q) => q.eq("id", id))
          .unique();
        if (row === null) return await this.bury("organizationDomains", id);
        if (!("deleted" in row)) await this.removeDomain(row);
        return;
      }
      case "connection": {
        const row = await db
          .query("connections")
          .withIndex("id", (q) => q.eq("id", id))
          .unique();
        if (row === null) return await this.bury("connections", id);
        if (!("deleted" in row)) {
          await db.replace("connections", row._id, this.removal(id));
          await this.emit({
            event: "connection.deleted",
            data: connectionOf(row),
          });
        }
        return;
      }
      case "directory": {
        // Its users and groups can be many, so they go a batch at a time in
        // `reconcile.sweep`.
        const row = await db
          .query("directories")
          .withIndex("id", (q) => q.eq("id", id))
          .unique();
        if (row === null) return await this.bury("directories", id);
        if ("deleted" in row) return;
        await db.replace("directories", row._id, {
          ...this.removal(id),
          sweeping: true,
        });
        await this.emit({ event: "dsync.deleted", data: directoryOf(row) });
        await this.ctx.scheduler.runAfter(0, internal.reconcile.sweep, {});
        return;
      }
      case "directoryUser": {
        const row = await db
          .query("directoryUsers")
          .withIndex("id", (q) => q.eq("id", id))
          .unique();
        if (row === null) return await this.bury("directoryUsers", id);
        if (!("deleted" in row)) {
          await db.replace("directoryUsers", row._id, this.removal(id));
          await this.emit({ event: "dsync.user.deleted", data: userOf(row) });
        }
        return;
      }
      case "directoryGroup": {
        const row = await db
          .query("directoryGroups")
          .withIndex("id", (q) => q.eq("id", id))
          .unique();
        if (row === null) return await this.bury("directoryGroups", id);
        if (!("deleted" in row)) {
          await db.replace("directoryGroups", row._id, this.removal(id));
          await this.emit({ event: "dsync.group.deleted", data: groupOf(row) });
        }
        return;
      }
    }
  }

  private removal(id: string) {
    return { id, deleted: true as const, generation: this.generation };
  }

  /** Record the removal of an object the copy never held. */
  private async bury(table: Table, id: string): Promise<void> {
    await this.ctx.db.insert(table, this.removal(id));
  }

  private async organization({
    row: next,
    updatedAt,
    domains,
  }: Extract<Update, { kind: "organization" }>) {
    const db = this.ctx.db;
    const row = await db
      .query("organizations")
      .withIndex("id", (q) => q.eq("id", next.id))
      .unique();
    if (!supersedes(row, updatedAt)) return;
    const fields = { ...next, updatedAt, generation: this.generation };
    if (row === null) await db.insert("organizations", fields);
    else await db.replace("organizations", row._id, fields);
    if (row === null || "deleted" in row || !same(organizationOf(row), next)) {
      await this.emit({
        event: row === null ? "organization.created" : "organization.updated",
        data: next,
      });
    }
    // A domain the organization no longer lists is removed only once a read
    // of it by id answers 404: this list may be older than the domain's own.
    for (const domain of domains) await this.domain(domain);
  }

  private async domain({ row: next, updatedAt }: DomainUpdate) {
    const db = this.ctx.db;
    const row = await db
      .query("organizationDomains")
      .withIndex("id", (q) => q.eq("id", next.id))
      .unique();
    if (!supersedes(row, updatedAt)) return;
    const fields = { ...next, updatedAt, generation: this.generation };
    if (row === null) await db.insert("organizationDomains", fields);
    else await db.replace("organizationDomains", row._id, fields);
    if (row === null || "deleted" in row || !same(domainOf(row), next)) {
      await this.emit({
        event:
          row === null
            ? "organization_domain.created"
            : "organization_domain.updated",
        data: next,
      });
    }
  }

  private async connection({
    row: next,
    updatedAt,
  }: Extract<Update, { kind: "connection" }>) {
    const db = this.ctx.db;
    const row = await db
      .query("connections")
      .withIndex("id", (q) => q.eq("id", next.id))
      .unique();
    if (!supersedes(row, updatedAt)) return;
    const fields = { ...next, updatedAt, generation: this.generation };
    if (row === null) await db.insert("connections", fields);
    else await db.replace("connections", row._id, fields);
    if (row === null || "deleted" in row || !same(connectionOf(row), next)) {
      await this.emit({
        event:
          next.state === "active"
            ? "connection.activated"
            : "connection.deactivated",
        data: next,
      });
    }
  }

  private async directory({
    row: next,
    updatedAt,
  }: Extract<Update, { kind: "directory" }>) {
    const db = this.ctx.db;
    const row = await db
      .query("directories")
      .withIndex("id", (q) => q.eq("id", next.id))
      .unique();
    if (!supersedes(row, updatedAt)) return;
    const fields = { ...next, updatedAt, generation: this.generation };
    if (row === null) await db.insert("directories", fields);
    else await db.replace("directories", row._id, fields);
    if (row === null || "deleted" in row || !same(directoryOf(row), next)) {
      await this.emit({ event: "dsync.activated", data: next });
    }
  }

  private async user({
    row: next,
    updatedAt,
  }: Extract<Update, { kind: "directoryUser" }>) {
    const db = this.ctx.db;
    const row = await db
      .query("directoryUsers")
      .withIndex("id", (q) => q.eq("id", next.id))
      .unique();
    const directory = await db
      .query("directories")
      .withIndex("id", (q) => q.eq("id", next.directoryId))
      .unique();
    if (!supersedes(row, updatedAt, directory)) return;
    const fields = { ...next, updatedAt, generation: this.generation };
    if (row === null) await db.insert("directoryUsers", fields);
    else await db.replace("directoryUsers", row._id, fields);
    if (row === null || "deleted" in row || !same(userOf(row), next)) {
      await this.emit({
        event: row === null ? "dsync.user.created" : "dsync.user.updated",
        data: next,
      });
    }
  }

  private async group({
    row: next,
    updatedAt,
  }: Extract<Update, { kind: "directoryGroup" }>) {
    const db = this.ctx.db;
    const row = await db
      .query("directoryGroups")
      .withIndex("id", (q) => q.eq("id", next.id))
      .unique();
    const directory = await db
      .query("directories")
      .withIndex("id", (q) => q.eq("id", next.directoryId))
      .unique();
    if (!supersedes(row, updatedAt, directory)) return;
    const fields = { ...next, updatedAt, generation: this.generation };
    if (row === null) await db.insert("directoryGroups", fields);
    else await db.replace("directoryGroups", row._id, fields);
    if (row === null || "deleted" in row || !same(groupOf(row), next)) {
      await this.emit({
        event: row === null ? "dsync.group.created" : "dsync.group.updated",
        data: next,
      });
    }
  }

  private async removeOrganization(
    row: Organization & { _id: Id<"organizations"> },
  ): Promise<void> {
    const domains = await this.ctx.db
      .query("organizationDomains")
      .withIndex("organizationId", (q) => q.eq("organizationId", row.id))
      .collect();
    for (const domain of domains) {
      if (!("deleted" in domain)) await this.removeDomain(domain);
    }
    await this.ctx.db.replace("organizations", row._id, this.removal(row.id));
    await this.emit({
      event: "organization.deleted",
      data: organizationOf(row),
    });
  }

  private async removeDomain(
    row: OrganizationDomain & { _id: Id<"organizationDomains"> },
  ): Promise<void> {
    await this.ctx.db.replace(
      "organizationDomains",
      row._id,
      this.removal(row.id),
    );
    await this.emit({
      event: "organization_domain.deleted",
      data: domainOf(row),
    });
  }

  /**
   * A user or group of a directory WorkOS deleted goes for good: the
   * directory's removal refuses any write to its contents.
   */
  async removeUser(row: DirectoryUser & { _id: Id<"directoryUsers"> }) {
    await this.ctx.db.delete("directoryUsers", row._id);
    await this.emit({ event: "dsync.user.deleted", data: userOf(row) });
  }

  async removeGroup(row: DirectoryGroup & { _id: Id<"directoryGroups"> }) {
    await this.ctx.db.delete("directoryGroups", row._id);
    await this.emit({ event: "dsync.group.deleted", data: groupOf(row) });
  }
}
