/**
 * WorkOS Admin Portal links, so a customer's IT admin sets up their SSO
 * connection, their SCIM directory and their domain themselves.
 *
 * @module
 */
import { v } from "convex/values";
import { action, env } from "./_generated/server.ts";
import { callWorkos } from "./rest.ts";

/**
 * Generate a short-lived Admin Portal link for one organization. The link is
 * returned, never stored. This does no authorization: the app decides who may
 * open its organization's portal before it calls this.
 */
export const generateLink = action({
  args: {
    organizationId: v.string(),
    intent: v.union(
      v.literal("sso"),
      v.literal("dsync"),
      v.literal("domain_verification"),
      v.literal("certificate_renewal"),
    ),
    /** Where the portal's back button goes. */
    returnUrl: v.optional(v.string()),
    /** Where the portal goes once the setup is done. */
    successUrl: v.optional(v.string()),
  },
  returns: v.object({ link: v.string() }),
  handler: async (_ctx, args) => {
    const reply = await callWorkos(env.CLIENT_SECRET, {
      method: "POST",
      path: "/portal/generate_link",
      body: {
        organization: args.organizationId,
        intent: args.intent,
        ...(args.returnUrl !== undefined ? { return_url: args.returnUrl } : {}),
        ...(args.successUrl !== undefined
          ? { success_url: args.successUrl }
          : {}),
      },
    });
    const body = reply.body;
    if (
      typeof body !== "object" ||
      body === null ||
      !("link" in body) ||
      typeof body.link !== "string"
    ) {
      throw new Error("WorkOS returned no portal link");
    }
    return { link: body.link };
  },
});
