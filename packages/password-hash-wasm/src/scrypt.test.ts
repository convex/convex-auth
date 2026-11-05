import { describe, expect, test } from "vitest";
import { verifyPassword } from "./scrypt.ts";

// Hashes made with `new Scrypt().hash(password)` of lucia 3.2.0, as PHC
// strings. lucia normalizes the password to NFKC before it hashes.
const ASCII = {
  password: "correct horse battery staple",
  phc: "$scrypt$ln=14,r=16,p=1$YzQwMzVkMTY1MzY3MDcwMDYxMDk0ZDQ0ZDRjODVkMzU$O9VL85i/QsMazu72eTz7j2uOe2SrPqP3RbluPdOAziT1Gw2xSo7YNg9CJ9Qsy+nSrSJ7Sfsv7ErBAIBt6+N+ug",
};
// U+FB01 ("ﬁ"): NFKC replaces it with "fi".
const LIGATURE = {
  password: "ﬁnancial-pâssword",
  phc: "$scrypt$ln=14,r=16,p=1$Y2E4MjdhZjNmYjIzOTJjNjE5YzA4MjI1ZThkYjdlNTY$zl5UUxgv206saZSfocHmFrX/pEeW0wryGs/9Tjcp8sFfyoCw7IWk1yiVYQvLzE6OY08B15mxBlEk7pNCU3rajw",
};

describe("scrypt", () => {
  test("verifies the password of a hash", async () => {
    const start = performance.now();
    expect(await verifyPassword(ASCII.password, ASCII.phc)).toBe(true);
    console.log(
      `verifyPassword (scrypt N=16384 r=16): ${Math.round(performance.now() - start)} ms`,
    );
    expect(await verifyPassword("wrong horse battery staple", ASCII.phc)).toBe(
      false,
    );
  });

  test("hashes the password as given", async () => {
    expect(await verifyPassword(LIGATURE.password, LIGATURE.phc)).toBe(false);
    expect(
      await verifyPassword(LIGATURE.password.normalize("NFKC"), LIGATURE.phc),
    ).toBe(true);
  });

  test("throws when the hash is not valid", async () => {
    await expect(verifyPassword("password", "not a hash")).rejects.toThrow(
      "Failed to verify password against the stored hash",
    );
    await expect(
      verifyPassword("password", ASCII.phc.replace("ln=14", "ln=17")),
    ).rejects.toThrow("parameters out of the supported limits");
  });
});
