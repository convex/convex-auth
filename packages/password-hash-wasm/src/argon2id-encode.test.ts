import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./argon2id.ts";
import { encodePHC } from "./argon2id-encode.ts";

function decodeB64(b64: string): Uint8Array {
  return Uint8Array.from(
    atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
}

describe("argon2id-encode", () => {
  test("encodes the parts of a hash back to the same hash", async () => {
    const phc = await hashPassword("correct horse battery staple");
    const [, , , params, salt, hash] = phc.split("$");
    const [m, t, p] = params
      .split(",")
      .map((part) => Number(part.split("=")[1]));

    const encoded = await encodePHC({
      m,
      t,
      p,
      salt: decodeB64(salt),
      hash: decodeB64(hash),
    });
    expect(encoded).toBe(phc);
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(
      true,
    );
  });

  test("throws on invalid values", async () => {
    await expect(
      encodePHC({
        m: 16384,
        t: 0,
        p: 1,
        salt: new Uint8Array(16),
        hash: new Uint8Array(32),
      }),
    ).rejects.toThrow("Failed to encode the argon2id hash");
  });
});
