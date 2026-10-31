/**
 * Reads of WorkOS organization domains, as the copy holds them.
 *
 * @module
 */
import { v } from "convex/values";
import { query } from "./_generated/server.ts";
import { connectionOf, domainOf, organizationOf } from "./mirror.ts";
import { vConnection, vOrganization, vOrganizationDomain } from "./schema.ts";

/**
 * Where to send an email address, or a bare domain, to sign in: the
 * organization that verified the domain, with its active SSO connection.
 * Pass the organization's `id` to `startSignInWithWorkos`. Returns null for a
 * domain that no organization signs in with SSO.
 */
export const get = query({
  args: { domain: v.string() },
  returns: v.union(
    v.null(),
    v.object({ organization: vOrganization, connection: vConnection }),
  ),
  handler: async (ctx, args) => {
    const domain = args.domain.slice(args.domain.lastIndexOf("@") + 1);
    const claims = await ctx.db
      .query("organizationDomains")
      .withIndex("domain", (q) => q.eq("domain", domain.toLowerCase()))
      .collect();
    for (const claim of claims) {
      if ("deleted" in claim || claim.state !== "verified") continue;
      const connections = await ctx.db
        .query("connections")
        .withIndex("organizationId_state", (q) =>
          q.eq("organizationId", claim.organizationId).eq("state", "active"),
        )
        .collect();
      const connection = connections.find((row) => !("deleted" in row));
      const organization = await ctx.db
        .query("organizations")
        .withIndex("id", (q) => q.eq("id", claim.organizationId))
        .unique();
      if (
        connection !== undefined &&
        !("deleted" in connection) &&
        organization !== null &&
        !("deleted" in organization)
      ) {
        return {
          organization: organizationOf(organization),
          connection: connectionOf(connection),
        };
      }
    }
    return null;
  },
});

/** An organization's domains. An organization holds a handful. */
export const list = query({
  args: { organizationId: v.string() },
  returns: v.array(vOrganizationDomain),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("organizationDomains")
      .withIndex("organizationId", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .collect();
    return rows.flatMap((row) => ("deleted" in row ? [] : [domainOf(row)]));
  },
});
