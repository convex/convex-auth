import { describe, expect, test } from "vitest";
import { encodePHC } from "./scrypt-encode.ts";
import { verifyPassword } from "./scrypt.ts";

// `new Scrypt().hash("correct horse battery staple")` of lucia 3.2.0.
const LUCIA =
  "c4035d165367070061094d44d4c85d35:3bd54bf398bf42c31aceeef6793cfb8f6b8e7b64ab3ea3f745b96e3dd380ce24f51b0db14a8ed8360f4227d42ccbe9d2ad227b49fb2fec4ac100806debe37eba";

function decodeHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

describe("scrypt-encode", () => {
  test("encodes a lucia hash that verifies", async () => {
    const [salt, key] = LUCIA.split(":");
    const phc = await encodePHC({
      ln: 14,
      r: 16,
      p: 1,
      salt: new TextEncoder().encode(salt),
      hash: decodeHex(key),
    });
    expect(phc).toBe(
      "$scrypt$ln=14,r=16,p=1$YzQwMzVkMTY1MzY3MDcwMDYxMDk0ZDQ0ZDRjODVkMzU$O9VL85i/QsMazu72eTz7j2uOe2SrPqP3RbluPdOAziT1Gw2xSo7YNg9CJ9Qsy+nSrSJ7Sfsv7ErBAIBt6+N+ug",
    );
    expect(await verifyPassword("correct horse battery staple", phc)).toBe(
      true,
    );
  });

  test("a salt of decoded hex does not verify", async () => {
    // lucia uses the hex string itself as the salt.
    const [salt, key] = LUCIA.split(":");
    const phc = await encodePHC({
      ln: 14,
      r: 16,
      p: 1,
      salt: decodeHex(salt),
      hash: decodeHex(key),
    });
    expect(await verifyPassword("correct horse battery staple", phc)).toBe(
      false,
    );
  });

  test("throws on invalid values", async () => {
    await expect(
      encodePHC({
        ln: 14,
        r: 16,
        p: 1,
        salt: new Uint8Array(16),
        hash: new Uint8Array(65),
      }),
    ).rejects.toThrow("Failed to encode the scrypt hash");
  });
});
