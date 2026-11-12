import { convexTest } from "convex-test";
import { defineSchema } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as z from "zod/mini";
import { verifyAttestation, type AttestationKind } from "./attestation.ts";
import { registerAttestationSigner } from "./attestationSigner.fixture.ts";

const GREETING: AttestationKind<z.ZodMiniObject<{ name: z.ZodMiniString }>> = {
  audience: "convex-auth/test/greeting",
  claims: z.object({ name: z.string() }),
};

const OTHER: AttestationKind<z.ZodMiniObject<{ name: z.ZodMiniString }>> = {
  audience: "convex-auth/test/other",
  claims: z.object({ name: z.string() }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    "./_generated/api.ts": async () => ({}),
  });
  const signer = registerAttestationSigner(t, "authGreeter");
  const verify = (token: string, kind = GREETING) =>
    t.run(async () => await verifyAttestation(kind, token));
  return { t, signer, verify };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attestations", () => {
  test("a component's attestation verifies, with its path and claims", async () => {
    const { signer, verify } = setup();
    const token = await signer.attest(GREETING, { name: "Alice" });
    await expect(verify(token)).resolves.toEqual({
      componentPath: "authGreeter",
      claims: { name: "Alice" },
    });
  });

  test("an attestation of a different kind is refused", async () => {
    const { signer, verify } = setup();
    const token = await signer.attest(OTHER, { name: "Alice" });
    await expect(verify(token)).rejects.toThrow(/audience/);
  });

  test("a token that the app signed is refused", async () => {
    const { t, verify } = setup();
    // The app's own functions sign with the deployment's origin as `iss`.
    const token = await t.run(
      async (ctx) =>
        await ctx.auth.signJwt({
          claims: { aud: GREETING.audience, name: "Alice" },
          expiresInSeconds: 1,
        }),
    );
    await expect(verify(token)).rejects.toThrow(/component/);
  });

  test("an expired attestation is refused, with no clock tolerance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { signer, verify } = setup();
    // The lifetime of a real attestation.
    const token = await signer.attest(GREETING, { name: "Alice" }, 1);
    vi.setSystemTime(new Date("2026-01-01T00:00:00.999Z"));
    await expect(verify(token)).resolves.toBeDefined();
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    await expect(verify(token)).rejects.toThrow(/expired/);
  });

  test("a token with a changed payload is refused", async () => {
    const { signer, verify } = setup();
    const token = await signer.attest(GREETING, { name: "Alice" });
    const [header, , signature] = token.split(".");
    const payload = btoa(
      JSON.stringify({
        ...JSON.parse(atob(token.split(".")[1]!)),
        name: "Mallory",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(verify(`${header}.${payload}.${signature}`)).rejects.toThrow(
      /signature/,
    );
  });

  test("claims that do not match the schema are refused", async () => {
    const { signer, verify } = setup();
    const token = await signer.signJwt({ aud: GREETING.audience, name: 42 });
    await expect(verify(token)).rejects.toThrow(/schema/);
  });

  test("a string that is not a JWT is refused", async () => {
    const { verify } = setup();
    await expect(verify("not-a-jwt")).rejects.toThrow(/JWT/);
  });
});
