import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./argon2id.ts";

describe("argon2id", () => {
  test("verifies the password of a hash", async () => {
    const phc = await hashPassword("correct horse battery staple");
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=16384,t=3,p=1\$/);
    expect(await verifyPassword("correct horse battery staple", phc)).toBe(
      true,
    );
    expect(await verifyPassword("wrong password", phc)).toBe(false);
  });

  test("throws when the hash is not a PHC string", async () => {
    await expect(verifyPassword("password", "not a hash")).rejects.toThrow(
      "Failed to verify password against the stored hash",
    );
  });
});
