import { v } from "convex/values";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

/**
 * Where an email signs in with SSO, for the sign-in page. Null for an email
 * whose domain no organization verified.
 */
export const route = query({
  args: { email: v.string() },
  returns: v.union(v.null(), v.object({ organizationId: v.string() })),
  handler: async (ctx, { email }) => {
    const found = await ctx.runQuery(
      components.authWorkos.organizationDomains.get,
      {
        domain: email,
      },
    );
    return found === null ? null : { organizationId: found.organization.id };
  },
});
