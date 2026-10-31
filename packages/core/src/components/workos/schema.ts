import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";
import {
  authorizationRequestsTable,
  ticketsTable,
} from "../../lib/oauth/schema.ts";

/**
 * The WorkOS objects the copy keeps, as WorkOS's API returns them, with their
 * fields in camelCase and only the fields the copy reads. `id` is WorkOS's id.
 */
export const vOrganization = v.object({
  id: v.string(),
  name: v.string(),
  externalId: v.optional(v.string()),
});
export type Organization = Infer<typeof vOrganization>;

export const vOrganizationDomain = v.object({
  id: v.string(),
  organizationId: v.string(),
  /** Lowercased. */
  domain: v.string(),
  /** e.g. `"verified"` or `"pending"`. */
  state: v.string(),
});
export type OrganizationDomain = Infer<typeof vOrganizationDomain>;

export const vConnection = v.object({
  id: v.string(),
  organizationId: v.optional(v.string()),
  /** e.g. `"OktaSAML"`. */
  connectionType: v.string(),
  name: v.optional(v.string()),
  /** e.g. `"active"` or `"inactive"`. */
  state: v.string(),
});
export type Connection = Infer<typeof vConnection>;

export const vDirectory = v.object({
  id: v.string(),
  organizationId: v.optional(v.string()),
  name: v.string(),
  /** e.g. `"okta scim v2.0"`. */
  type: v.string(),
  /** e.g. `"linked"`. */
  state: v.string(),
});
export type Directory = Infer<typeof vDirectory>;

const vRole = v.object({ slug: v.string() });

export const vDirectoryUser = v.object({
  id: v.string(),
  directoryId: v.string(),
  organizationId: v.optional(v.string()),
  /** The user's id at the identity provider, the same `idpId` SSO returns. */
  idpId: v.string(),
  /** Lowercased. */
  email: v.optional(v.string()),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  /** `"active"`, or `"inactive"` once the directory deprovisioned the user. */
  state: v.string(),
  role: v.optional(vRole),
  roles: v.optional(v.array(vRole)),
});
export type DirectoryUser = Infer<typeof vDirectoryUser>;

export const vDirectoryGroup = v.object({
  id: v.string(),
  directoryId: v.string(),
  organizationId: v.optional(v.string()),
  idpId: v.optional(v.string()),
  name: v.string(),
});
export type DirectoryGroup = Infer<typeof vDirectoryGroup>;

/**
 * A change to the copy, named with WorkOS's event for it, and carrying the
 * object as WorkOS holds it now (or, for a deletion, as the copy last held
 * it). A write that changes nothing has no event.
 */
export const vWorkosEvent = v.union(
  v.object({
    event: v.union(
      v.literal("organization.created"),
      v.literal("organization.updated"),
      v.literal("organization.deleted"),
    ),
    data: vOrganization,
  }),
  v.object({
    event: v.union(
      v.literal("organization_domain.created"),
      v.literal("organization_domain.updated"),
      v.literal("organization_domain.deleted"),
    ),
    data: vOrganizationDomain,
  }),
  v.object({
    event: v.union(
      v.literal("connection.activated"),
      v.literal("connection.deactivated"),
      v.literal("connection.deleted"),
    ),
    data: vConnection,
  }),
  v.object({
    event: v.union(v.literal("dsync.activated"), v.literal("dsync.deleted")),
    data: vDirectory,
  }),
  v.object({
    event: v.union(
      v.literal("dsync.user.created"),
      v.literal("dsync.user.updated"),
      v.literal("dsync.user.deleted"),
    ),
    data: vDirectoryUser,
  }),
  v.object({
    event: v.union(
      v.literal("dsync.group.created"),
      v.literal("dsync.group.updated"),
      v.literal("dsync.group.deleted"),
    ),
    data: vDirectoryGroup,
  }),
);
export type WorkosEvent = Infer<typeof vWorkosEvent>;

/** Each event's name, with the object it carries. */
export type WorkosEvents = {
  [Name in WorkosEvent["event"]]: WorkosEvent extends infer Each
    ? Each extends { event: infer Names; data: infer Data }
      ? Name extends Names
        ? Data
        : never
      : never
    : never;
};

/**
 * Where a reconcile is: the listing it is on, the directory the listing is
 * scoped to, and WorkOS's cursor within it.
 */
export const vBackfillPosition = v.union(
  v.object({
    stage: v.union(
      v.literal("organizations"),
      v.literal("connections"),
      v.literal("directories"),
    ),
    after: v.optional(v.string()),
  }),
  v.object({
    stage: v.union(v.literal("directoryUsers"), v.literal("directoryGroups")),
    directoryId: v.string(),
    after: v.optional(v.string()),
  }),
);
export type BackfillPosition = Infer<typeof vBackfillPosition>;

/**
 * Every row carries the time it was last written or listed, and WorkOS's
 * `updated_at` for the version it holds: a read that commits after a newer
 * one is dropped. A reconcile that started at time T reads each row older
 * than T again by id, and removes it only if WorkOS no longer has it.
 */
const kept = {
  generation: v.number(),
  updatedAt: v.string(),
};

/**
 * What a removal leaves: the id alone, marked `deleted`, whether or not the
 * copy held the object, so a read from before the removal cannot write it
 * back. WorkOS never reuses an id.
 */
const removed = {
  id: v.string(),
  deleted: v.literal(true),
  generation: v.number(),
};

export default defineSchema({
  authorizationRequests: authorizationRequestsTable,
  tickets: ticketsTable,

  organizations: defineTable(
    v.union(v.object({ ...vOrganization.fields, ...kept }), v.object(removed)),
  )
    .index("id", ["id"])
    .index("deleted_generation", ["deleted", "generation"]),
  organizationDomains: defineTable(
    v.union(
      v.object({ ...vOrganizationDomain.fields, ...kept }),
      v.object(removed),
    ),
  )
    .index("id", ["id"])
    .index("domain", ["domain"])
    .index("organizationId", ["organizationId"])
    .index("deleted_generation", ["deleted", "generation"]),
  connections: defineTable(
    v.union(v.object({ ...vConnection.fields, ...kept }), v.object(removed)),
  )
    .index("id", ["id"])
    .index("organizationId_state", ["organizationId", "state"])
    .index("deleted_generation", ["deleted", "generation"]),
  /**
   * A directory WorkOS deleted is `sweeping` until `sweep` has removed its
   * users and groups, a batch at a time, and its removal stays after that.
   */
  directories: defineTable(
    v.union(
      v.object({ ...vDirectory.fields, ...kept }),
      v.object({ ...removed, sweeping: v.optional(v.literal(true)) }),
    ),
  )
    .index("id", ["id"])
    .index("organizationId", ["organizationId"])
    .index("sweeping", ["sweeping"])
    .index("deleted_generation", ["deleted", "generation"]),
  directoryUsers: defineTable(
    v.union(v.object({ ...vDirectoryUser.fields, ...kept }), v.object(removed)),
  )
    .index("id", ["id"])
    .index("directoryId_id", ["directoryId", "id"])
    .index("organizationId_id", ["organizationId", "id"])
    .index("organizationId_idpId_id", ["organizationId", "idpId", "id"])
    .index("idpId_id", ["idpId", "id"])
    .index("email_id", ["email", "id"])
    .index("deleted_generation", ["deleted", "generation"]),
  directoryGroups: defineTable(
    v.union(
      v.object({ ...vDirectoryGroup.fields, ...kept }),
      v.object(removed),
    ),
  )
    .index("id", ["id"])
    .index("directoryId_id", ["directoryId", "id"])
    .index("organizationId_id", ["organizationId", "id"])
    .index("deleted_generation", ["deleted", "generation"]),

  /**
   * The deployment's one webhook endpoint at WorkOS, which `webhook.register`
   * creates, the secret WorkOS signs its deliveries with, and the app's
   * event handler, as a function handle.
   */
  webhook: defineTable({
    endpointId: v.string(),
    url: v.string(),
    secret: v.string(),
    onEvent: v.string(),
  }),
});
