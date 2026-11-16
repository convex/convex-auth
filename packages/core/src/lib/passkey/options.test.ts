import { describe, expect, test } from "vitest";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { toBase64URL } from "./base64url.ts";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
} from "./options.ts";
import {
  CHALLENGE_TTL_MS,
  SUPPORTED_ALGORITHM_IDS,
} from "../../components/passkey/constants.ts";

const RP_ID = "example.com";
const RP_NAME = "Example";

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

describe("toBase64URL", () => {
  // The method assembles its options objects without
  // `@simplewebauthn/server`, which would pull the X.509 and ASN.1 stack
  // into the app-side bundle for one encode. These cases hold the
  // replacement to the encoding of the library.
  test("matches the encoder of the library", () => {
    for (let length = 0; length < 130; length += 1) {
      const buffer = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        // A fixed pattern that covers every byte value.
        buffer[index] = (index * 7 + length) % 256;
      }
      expect(toBase64URL(buffer.buffer)).toBe(isoBase64URL.fromBuffer(buffer));
    }
  });

  test("emits no padding and none of the characters base64 reserves", () => {
    // 0xFB 0xFF encodes to "+/8=" in base64, which is the case that tells
    // the two alphabets apart.
    expect(toBase64URL(bytes(0xfb, 0xff))).toBe("-_8");
  });

  test("encodes an empty buffer as an empty string", () => {
    expect(toBase64URL(new ArrayBuffer(0))).toBe("");
  });
});

describe("buildRegistrationOptions", () => {
  const build = (
    overrides: Partial<Parameters<typeof buildRegistrationOptions>[0]> = {},
  ) =>
    buildRegistrationOptions({
      rpId: RP_ID,
      rpName: RP_NAME,
      challenge: bytes(1, 2, 3),
      userHandle: bytes(4, 5, 6),
      userName: "ada",
      userDisplayName: "Ada",
      excludeCredentials: [],
      ...overrides,
    });

  test("encodes the challenge and the user handle as base64url", () => {
    const options = build();
    expect(options.challenge).toBe(toBase64URL(bytes(1, 2, 3)));
    expect(options.user).toEqual({
      id: toBase64URL(bytes(4, 5, 6)),
      name: "ada",
      displayName: "Ada",
    });
    expect(options.rp).toEqual({ id: RP_ID, name: RP_NAME });
  });

  test("offers exactly the algorithms the verification enforces", () => {
    expect(build().pubKeyCredParams).toEqual(
      SUPPORTED_ALGORITHM_IDS.map((alg) => ({ alg, type: "public-key" })),
    );
  });

  test("asks for a discoverable credential and user verification", () => {
    const options = build();
    expect(options.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(options.attestation).toBe("none");
  });

  test("requests no extensions", () => {
    // The wire validator refuses any other extension.
    expect(build().extensions).toEqual({});
  });

  test("gives the browser less time than the challenge has to live", () => {
    // The challenge starts ageing when the start mutation stores it, which
    // is before the browser starts its own countdown. A ceremony that the
    // browser still accepts must never come back as `CHALLENGE_EXPIRED`.
    expect(build().timeout).toBeLessThan(CHALLENGE_TTL_MS);
  });

  test("turns the excluded credentials into JSON descriptors", () => {
    const options = build({
      excludeCredentials: [
        { id: bytes(7, 8), transports: ["usb", "internal"] },
        { id: bytes(9), transports: undefined },
      ],
    });
    expect(options.excludeCredentials).toEqual([
      {
        id: toBase64URL(bytes(7, 8)),
        type: "public-key",
        transports: ["usb", "internal"],
      },
      { id: toBase64URL(bytes(9)), type: "public-key" },
    ]);
    // An absent `transports` is absent, not `undefined`: the wire validator
    // marks it optional, and Convex refuses a key whose value is undefined
    // only after it drops it, which hides the difference in tests.
    expect("transports" in options.excludeCredentials[1]).toBe(false);
  });
});

describe("buildAuthenticationOptions", () => {
  test("builds a discoverable-credential request from an empty list", () => {
    const options = buildAuthenticationOptions({
      rpId: RP_ID,
      challenge: bytes(1, 2, 3),
      allowCredentials: [],
    });
    expect(options).toEqual({
      challenge: toBase64URL(bytes(1, 2, 3)),
      timeout: options.timeout,
      rpId: RP_ID,
      allowCredentials: [],
      userVerification: "required",
    });
    expect(options.timeout).toBeLessThan(CHALLENGE_TTL_MS);
  });

  test("turns the allowed credentials into JSON descriptors", () => {
    const options = buildAuthenticationOptions({
      rpId: RP_ID,
      challenge: bytes(1),
      allowCredentials: [{ id: bytes(7, 8), transports: ["hybrid"] }],
    });
    expect(options.allowCredentials).toEqual([
      {
        id: toBase64URL(bytes(7, 8)),
        type: "public-key",
        transports: ["hybrid"],
      },
    ]);
  });
});
