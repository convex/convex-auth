import { internalMutation } from "./_generated/server.ts";
import { authConfiguration } from "../lib/configuration.ts";
import { resolveTtlConfig } from "./configuration.ts";
import { v } from "convex/values";

/** Persist installation settings on every push without modifying identity data. */
export const configure = internalMutation({
  args: authConfiguration,
  returns: v.null(),
  handler: async (ctx, args) => {
    resolveTtlConfig(args);
    const names = new Set<string>();
    for (const provider of args.providers ?? []) {
      if (names.has(provider.name)) {
        throw new Error(
          `A provider named "${provider.name}" is already configured.`,
        );
      }
      names.add(provider.name);
    }
    const existing = await ctx.db.query("configuration").unique();
    if (existing === null) {
      await ctx.db.insert("configuration", args);
    } else {
      // Replace so removing an optional hook or setting actually removes it.
      await ctx.db.replace("configuration", existing._id, args);
    }
    return null;
  },
});
