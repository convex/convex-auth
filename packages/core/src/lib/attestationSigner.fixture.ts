/**
 * Test-only: a component that signs any deployment JWT. Register it under the
 * path of the component that a test must impersonate, for example `"auth"`,
 * to make attestations that seem to come from that component.
 *
 * The file has two dots in its name, thus it does not ship with the package.
 *
 * @module
 */
import type { TestConvex } from "convex-test";
import {
  defineSchema,
  mutationGeneric,
  type FunctionReference,
  type GenericSchema,
  type SchemaDefinition,
} from "convex/server";
import { v } from "convex/values";
import * as z from "zod/mini";
import { signAttestation, type AttestationKind } from "./attestation.ts";

const signer = {
  sign: mutationGeneric({
    args: { claims: v.any(), expiresInSeconds: v.number() },
    returns: v.string(),
    handler: async (ctx, { claims, expiresInSeconds }) =>
      await ctx.auth.signJwt({ claims, expiresInSeconds }),
  }),
};

/**
 * The lifetime of the tokens that the test signer makes, in seconds.
 *
 * A real attestation is signed and verified in the same transaction, in which
 * the clock does not move. A test signs in one transaction and verifies in a
 * later one. The deployment rounds `iat` down to the second, thus a token with
 * the real lifetime of one second can expire right after it was signed.
 */
const TEST_LIFETIME_SECONDS = 60;

const modules = {
  "./_generated/api.ts": async () => ({}),
  "./signer.ts": async () => signer,
};

/**
 * Register a component that signs tokens at `componentPath`, and return
 * functions that sign tokens as that component.
 */
export function registerAttestationSigner(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  componentPath: string,
) {
  const component = t.registerComponent<{
    signer: {
      sign: FunctionReference<
        "mutation",
        "internal",
        { claims: unknown; expiresInSeconds: number },
        string
      >;
    };
  }>(componentPath, defineSchema({}), modules);
  const sign = component.signer.sign;
  return {
    /** Sign a token with any claims. */
    signJwt: async (
      claims: Record<string, unknown>,
      expiresInSeconds = TEST_LIFETIME_SECONDS,
    ): Promise<string> => await t.mutation(sign, { claims, expiresInSeconds }),
    /**
     * Sign an attestation of the given kind, as {@link signAttestation} does,
     * but with a lifetime of `expiresInSeconds`.
     */
    attest: async <Claims extends z.ZodMiniType>(
      kind: AttestationKind<Claims>,
      claims: z.input<Claims>,
      expiresInSeconds = TEST_LIFETIME_SECONDS,
    ): Promise<string> =>
      await signAttestation(
        {
          auth: {
            signJwt: async (options) =>
              await t.mutation(sign, {
                claims: options.claims,
                expiresInSeconds,
              }),
          },
        },
        kind,
        claims,
      ),
  };
}
