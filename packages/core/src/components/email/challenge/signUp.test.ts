import { afterEach, describe, expect, test, vi } from "vitest";
import { decodeJwt } from "jose";
import { USER_ATTESTATION } from "../../../lib/attestationKinds.ts";
import {
  registerResendStub,
  stubEmailSender,
  sentEmails,
} from "../../../testing/resend.ts";
import { api } from "../_generated/api.ts";
import { registerAttestationSigner } from "../../../lib/attestationSigner.fixture.ts";
import { NEW_USER_ATTESTATION } from "../../../lib/attestationKinds.ts";

import {
  newUserAttestation,
  seedEmail,
  seedChallenge,
  setup as setupComponent,
} from "../../emailTestSetup.ts";

/** The component's test instance, plus the stub that catches the emails. */
function setup() {
  const t = setupComponent();
  registerResendStub(t);
  return t;
}

const IP = "203.0.113.7";
const URL = "https://app.example/validate-email";

/** The code that the emailed link carries. */
function emailCodeInLink(text: string | undefined): string {
  const match = /[?&]code=([^\s&]+)/.exec(text ?? "");
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return decodeURIComponent(match[1]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("challenge.signUp.complete", () => {
  test("records the address as primary for the user of the challenge", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signUp", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.signUp.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
      }),
    ).toMatchObject({
      success: true,
      userId: "user1",
      email: "alice@example.com",
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("an address verified after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signUp", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    // Another sign-up for the same address completes first.
    await seedEmail(t, "user2", "Alice@Example.com", true);

    expect(
      await t.mutation(api.challenge.signUp.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });
});

describe("a user with an email address", () => {
  for (const [name, secondEmail] of [
    ["the same address", "alice@example.com"],
    ["another address", "alice@work.example"],
  ] as const) {
    test(`a second signUp challenge for ${name} fails with INVALID_CHALLENGE`, async () => {
      const t = setup();
      await seedChallenge(t, {
        email: "alice@example.com",
        purpose: { kind: "signUp", userId: "user1" },
        emailCode: "code1",
        browserSecret: "secret1",
      });
      await seedChallenge(t, {
        email: secondEmail,
        purpose: { kind: "signUp", userId: "user1" },
        emailCode: "code2",
        browserSecret: "secret2",
      });
      expect(
        await t.mutation(api.challenge.signUp.complete, {
          emailCode: "code1",
          browserSecret: "secret1",
        }),
      ).toMatchObject({ success: true });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        await t.mutation(api.challenge.signUp.complete, {
          emailCode: "code2",
          browserSecret: "secret2",
        }),
      ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/already has an email address/),
      );
      // The first address stays the only one, and the link is used up.
      expect(
        await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
      ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
      expect(
        await t.run((ctx) => ctx.db.query("challenges").collect()),
      ).toEqual([]);
    });
  }
});

describe("the kind of a signUp challenge", () => {
  test("an addEmail challenge cannot complete as a signUp", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    // The kind check keeps a caller from completing an `addEmail` challenge
    // without its `userId`.
    await expect(
      t.mutation(api.challenge.signUp.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
      }),
    ).rejects.toThrow(/"addEmail".*"signUp"/);
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });

  test("a signUp challenge cannot complete as an addEmail", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signUp", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    await expect(
      t.mutation(api.challenge.addEmail.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        userId: "user1",
      }),
    ).rejects.toThrow(/"signUp".*"addEmail"/);
    // The row stays, thus the right kind still works.
    expect(
      await t.mutation(api.challenge.signUp.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
      }),
    ).toMatchObject({ success: true, userId: "user1" });
  });
});

describe("challenge.signUp.start", () => {
  test("sends a link that completes the challenge for the user", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.signUp.start, {
        email: "alice@example.com",
        url: URL,
        emailSender: await stubEmailSender(t),
        newUser: await newUserAttestation(t, "user1"),
      });
    if (!result.success) {
      throw new Error("The start failed: " + result.userError.error);
    }
    expect(
      await t.run((ctx) => ctx.db.get("challenges", result.challengeId)),
    ).toMatchObject({
      email: "alice@example.com",
      purpose: { kind: "signUp", userId: "user1" },
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["alice@example.com"]);
    expect(sent[0].subject).toBe("Validate your email address");

    expect(
      await t.mutation(api.challenge.signUp.complete, {
        emailCode: emailCodeInLink(sent[0].text),
        browserSecret: result.browserSecret,
      }),
    ).toMatchObject({
      success: true,
      userId: "user1",
      email: "alice@example.com",
    });
  });

  test("rejects a taken address with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedEmail(t, "user2", "alice@example.com", true);

    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.signUp.start, {
          email: "Alice@Example.com",
          url: URL,
          emailSender: await stubEmailSender(t),
          newUser: await newUserAttestation(t, "user1"),
        }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
    expect(await sentEmails(t)).toEqual([]);
  });

  test("throws when the user already has an email", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);

    await expect(
      t.withRequestMetadata({ ip: IP }).mutation(api.challenge.signUp.start, {
        email: "alice@work.example",
        url: URL,
        emailSender: await stubEmailSender(t),
        newUser: await newUserAttestation(t, "user1"),
      }),
    ).rejects.toThrow(/already has an email/);
    expect(await sentEmails(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
  });
});

describe("challenge.signUp.check", () => {
  test("returns the same errors as start", async () => {
    const t = setup();
    const check = (email: string) =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.signUp.check, { email });
    expect(await check("alice@example.com")).toBeNull();
    expect(await check("not an address")).toEqual({ error: "INVALID_EMAIL" });

    await seedEmail(t, "user2", "taken@example.com", true);
    expect(await check("Taken@Example.com")).toEqual({ error: "EMAIL_TAKEN" });
  });
});

describe("challenge.signUp attestations", () => {
  test("start refuses a new-user attestation that the core did not sign", async () => {
    const t = setup();
    const other = registerAttestationSigner(t, "authOther");
    await expect(
      t.withRequestMetadata({ ip: IP }).mutation(api.challenge.signUp.start, {
        email: "alice@example.com",
        url: URL,
        emailSender: await stubEmailSender(t),
        newUser: await other.attest(NEW_USER_ATTESTATION, { userId: "user1" }),
      }),
    ).rejects.toThrow("the core did not sign it");
  });

  test("complete attests the user of the challenge", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signUp", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    const result = await t.mutation(api.challenge.signUp.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    if (!result.success) throw new Error("expected success");
    expect(decodeJwt(result.attestation)).toMatchObject({
      aud: USER_ATTESTATION.audience,
      userId: "user1",
    });
  });
});
