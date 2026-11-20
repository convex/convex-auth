import { expect, test } from "vitest";
import { makeFunctionReference } from "convex/server";
import { credentialSessions } from "../credentialSessions.fixture.ts";

test("changePassword rejects impersonation and preserves normal password validation", async () => {
  const { normal, impersonating } = await credentialSessions();
  const fn = makeFunctionReference<"mutation">("testApp:changePassword");
  const args = {
    currentPassword: "correct horse battery staple",
    newPassword: "short",
  };
  await expect(impersonating.mutation(fn, args)).rejects.toThrow(
    /IMPERSONATING/,
  );
  await expect(normal.mutation(fn, args)).resolves.toMatchObject({
    success: false,
    userError: { error: "PASSWORD_TOO_SHORT" },
  });
});
