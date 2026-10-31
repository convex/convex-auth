/**
 * Decoding what WorkOS's API sends: list pages, events, and the objects in
 * them. It is untrusted JSON, so each field the copy reads is checked before
 * it is used, and anything else fails as a {@link DecodeError}. Fields WorkOS
 * adds over time are ignored.
 *
 * @module
 */
import { Infer, v } from "convex/values";
import {
  vConnection,
  vDirectory,
  vDirectoryGroup,
  vDirectoryUser,
  vOrganization,
  vOrganizationDomain,
  type DirectoryUser,
} from "./schema.ts";
import { EVENTS } from "./constants.ts";

export class DecodeError extends Error {
  override readonly name = "DecodeError";
}

/** A kind of WorkOS object, each read by id from its own endpoint. */
export const vKind = v.union(
  v.literal("organization"),
  v.literal("organizationDomain"),
  v.literal("connection"),
  v.literal("directory"),
  v.literal("directoryUser"),
  v.literal("directoryGroup"),
);
export type Kind = Infer<typeof vKind>;

const vDomainUpdate = v.object({
  row: vOrganizationDomain,
  updatedAt: v.string(),
});
export type DomainUpdate = Infer<typeof vDomainUpdate>;

/**
 * One object as WorkOS holds it now, decoded from a listing or a read by id,
 * as the write it makes to the copy, with WorkOS's `updated_at` for that
 * version. An organization carries its domains.
 */
export const vUpdate = v.union(
  v.object({
    kind: v.literal("organization"),
    row: vOrganization,
    updatedAt: v.string(),
    domains: v.array(vDomainUpdate),
  }),
  v.object({
    kind: v.literal("organizationDomain"),
    row: vOrganizationDomain,
    updatedAt: v.string(),
  }),
  v.object({
    kind: v.literal("connection"),
    row: vConnection,
    updatedAt: v.string(),
  }),
  v.object({
    kind: v.literal("directory"),
    row: vDirectory,
    updatedAt: v.string(),
  }),
  v.object({
    kind: v.literal("directoryUser"),
    row: vDirectoryUser,
    updatedAt: v.string(),
  }),
  v.object({
    kind: v.literal("directoryGroup"),
    row: vDirectoryGroup,
    updatedAt: v.string(),
  }),
);
export type Update = Infer<typeof vUpdate>;

type Fields = Record<string, unknown>;

function fields(value: unknown, what: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecodeError(`WorkOS sent a ${what} that is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(object: Fields, name: string, what: string): string {
  const value = object[name];
  if (typeof value !== "string") {
    throw new DecodeError(`WorkOS sent a ${what} with no \`${name}\``);
  }
  return value;
}

function optionalText(object: Fields, name: string): string | undefined {
  const value = object[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * A domain an organization lists may carry no `updated_at` of its own, and is
 * as new as the organization that listed it.
 */
function domain(
  value: unknown,
  organization?: { id: string; updatedAt: string },
): DomainUpdate {
  const raw = fields(value, "organization domain");
  const owner = optionalText(raw, "organization_id") ?? organization?.id;
  if (owner === undefined) {
    throw new DecodeError("WorkOS sent a domain with no organization");
  }
  const updatedAt = optionalText(raw, "updated_at") ?? organization?.updatedAt;
  if (updatedAt === undefined) {
    throw new DecodeError("WorkOS sent a domain with no `updated_at`");
  }
  return {
    row: {
      id: text(raw, "id", "organization domain"),
      organizationId: owner,
      domain: text(raw, "domain", "organization domain").toLowerCase(),
      state: optionalText(raw, "state") ?? "pending",
    },
    updatedAt,
  };
}

function organization(value: unknown): Update {
  const raw = fields(value, "organization");
  const id = text(raw, "id", "organization");
  const updatedAt = text(raw, "updated_at", "organization");
  const domains = raw.domains;
  return {
    kind: "organization",
    row: {
      id,
      name: text(raw, "name", "organization"),
      externalId: optionalText(raw, "external_id"),
    },
    updatedAt,
    domains: Array.isArray(domains)
      ? domains.map((item) => domain(item, { id, updatedAt }))
      : [],
  };
}

function connection(value: unknown): Update {
  const raw = fields(value, "connection");
  return {
    kind: "connection",
    row: {
      id: text(raw, "id", "connection"),
      organizationId: optionalText(raw, "organization_id"),
      connectionType: text(raw, "connection_type", "connection"),
      name: optionalText(raw, "name"),
      state: text(raw, "state", "connection"),
    },
    updatedAt: text(raw, "updated_at", "connection"),
  };
}

function directory(value: unknown): Update {
  const raw = fields(value, "directory");
  return {
    kind: "directory",
    row: {
      id: text(raw, "id", "directory"),
      organizationId: optionalText(raw, "organization_id"),
      name: text(raw, "name", "directory"),
      type: text(raw, "type", "directory"),
      state: text(raw, "state", "directory"),
    },
    updatedAt: text(raw, "updated_at", "directory"),
  };
}

function role(value: unknown): { slug: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const slug = optionalText(fields(value, "role"), "slug");
  return slug === undefined ? undefined : { slug };
}

function user(value: unknown): Update {
  const raw = fields(value, "directory user");
  const row: DirectoryUser = {
    id: text(raw, "id", "directory user"),
    directoryId: text(raw, "directory_id", "directory user"),
    organizationId: optionalText(raw, "organization_id"),
    idpId: text(raw, "idp_id", "directory user"),
    email: optionalText(raw, "email")?.toLowerCase(),
    firstName: optionalText(raw, "first_name"),
    lastName: optionalText(raw, "last_name"),
    state: text(raw, "state", "directory user"),
    role: role(raw.role),
    roles: Array.isArray(raw.roles)
      ? raw.roles.flatMap((item) => role(item) ?? [])
      : undefined,
  };
  return {
    kind: "directoryUser",
    row,
    updatedAt: text(raw, "updated_at", "directory user"),
  };
}

function group(value: unknown): Update {
  const raw = fields(value, "directory group");
  return {
    kind: "directoryGroup",
    row: {
      id: text(raw, "id", "directory group"),
      directoryId: text(raw, "directory_id", "directory group"),
      organizationId: optionalText(raw, "organization_id"),
      idpId: optionalText(raw, "idp_id"),
      name: text(raw, "name", "directory group"),
    },
    updatedAt: text(raw, "updated_at", "directory group"),
  };
}

const HANDLED = new Set<string>(EVENTS);

/** An object a webhook delivery says changed, to be read again by id. */
export type Target = { kind: Kind; id: string };

function target(name: string, data: unknown): Target {
  const raw = fields(data, "event object");
  // WorkOS keeps no membership object: a membership change is a change to
  // the directory user, whose roles it may move.
  if (
    name === "dsync.group.user_added" ||
    name === "dsync.group.user_removed"
  ) {
    const member = fields(raw.user, "directory user");
    return { kind: "directoryUser", id: text(member, "id", "directory user") };
  }
  if (name === "organization_domain.verification_failed") {
    const failed = fields(raw.organization_domain, "organization domain");
    return {
      kind: "organizationDomain",
      id: text(failed, "id", "organization domain"),
    };
  }
  const id = text(raw, "id", "event object");
  if (name === "dsync.activated" || name === "dsync.deleted") {
    return { kind: "directory", id };
  }
  if (name.startsWith("dsync.user.")) return { kind: "directoryUser", id };
  if (name.startsWith("dsync.group.")) return { kind: "directoryGroup", id };
  if (name.startsWith("organization_domain.")) {
    return { kind: "organizationDomain", id };
  }
  if (name.startsWith("organization.")) return { kind: "organization", id };
  return { kind: "connection", id };
}

/** A list page: its objects, and the cursor of the next page if any. */
export function decodeList(value: unknown): {
  items: unknown[];
  after: string | undefined;
} {
  const raw = fields(value, "list");
  if (!Array.isArray(raw.data)) {
    throw new DecodeError("WorkOS sent a list with no `data`");
  }
  const metadata = fields(raw.list_metadata, "list metadata");
  return { items: raw.data, after: optionalText(metadata, "after") };
}

/**
 * The object a webhook delivery names, or null for an event the copy does
 * not keep. The delivery's payload is not applied: WorkOS does not deliver in
 * order, so the object is read again as it is now.
 */
export function decodeEvent(value: unknown): Target | null {
  const raw = fields(value, "event");
  const name = text(raw, "event", "event");
  if (!HANDLED.has(name)) return null;
  return target(name, raw.data);
}

/** The path that reads one object by id. */
export function objectPath(kind: Kind, id: string): string {
  const collection = {
    organization: "organizations",
    organizationDomain: "organization_domains",
    connection: "connections",
    directory: "directories",
    directoryUser: "directory_users",
    directoryGroup: "directory_groups",
  }[kind];
  return `/${collection}/${encodeURIComponent(id)}`;
}

/** One object read by id or listed, decoded as the write it makes. */
export function decodeObject(kind: Kind, value: unknown): Update {
  switch (kind) {
    case "organization":
      return organization(value);
    case "organizationDomain":
      return { kind: "organizationDomain", ...domain(value) };
    case "connection":
      return connection(value);
    case "directory":
      return directory(value);
    case "directoryUser":
      return user(value);
    case "directoryGroup":
      return group(value);
  }
}

/** A webhook endpoint, from WorkOS's `/webhook_endpoints` API. */
export function decodeEndpoint(value: unknown): {
  id: string;
  url: string;
  secret: string;
  enabled: boolean;
  events: string[];
} {
  const raw = fields(value, "webhook endpoint");
  const events = Array.isArray(raw.events)
    ? raw.events.filter((event) => typeof event === "string")
    : [];
  return {
    id: text(raw, "id", "webhook endpoint"),
    url: text(raw, "endpoint_url", "webhook endpoint"),
    secret: text(raw, "secret", "webhook endpoint"),
    enabled: optionalText(raw, "status") === "enabled",
    events,
  };
}
